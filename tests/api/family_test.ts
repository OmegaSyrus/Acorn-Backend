import { assert, assertEquals } from "jsr:@std/assert@1";
import { pairedDevice, parentWithFamily, world } from "./helpers.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

Deno.test("a family needs a signed-in adult and a consent version", async () => {
  const w = await world();
  try {
    assertEquals((await w.call("GET", "/family")).status, 401, "no sign-in");
    assertEquals((await w.call("GET", "/family", { auth: "Bearer nope" })).status, 401, "bad token");
    await w.deps.sql`insert into auth.users (id) values (${A})`;
    const auth = `Bearer parent:${A}`;
    const none = await w.call("GET", "/family", { auth });
    assertEquals(none.status, 409);
    assertEquals(none.body.reason, "no_family");
    assertEquals((await w.call("POST", "/family", { auth, body: {} })).status, 400, "consent is required");
    const made = await w.call("POST", "/family", { auth, body: { consent_version: "2026-11-v1" } });
    assertEquals(made.status, 201);
    assertEquals(made.body.role, "owner");
    const again = await w.call("POST", "/family", { auth, body: { consent_version: "2026-11-v1" } });
    assertEquals(again.status, 200, "a second POST returns the same family");
    assertEquals(again.body.family, made.body.family);
    const [c] = await w.deps.sql`select version, method from consents`;
    assertEquals([c.version, c.method], ["2026-11-v1", "email_plus"], "consent recorded");
  } finally {
    await w.close();
  }
});

Deno.test("children: add, rename, limits, and another family can't touch them", async () => {
  const w = await world();
  try {
    const a = await parentWithFamily(w, A);
    const b = await parentWithFamily(w, B);
    const bear = await w.call("POST", "/family/children", { auth: a, body: { nickname: " Bear ", birth_year: 2020, picture: "fox" } });
    assertEquals(bear.status, 201);
    assert(/^c_[0-9a-f]{12}$/.test(bear.body.child));
    assertEquals(bear.body.nickname, "Bear");
    assertEquals((await w.call("POST", "/family/children", { auth: a, body: { nickname: "" } })).status, 400);
    assertEquals((await w.call("POST", "/family/children", { auth: a, body: { nickname: "X", birth_year: 1990 } })).status, 400);
    const ren = await w.call("PATCH", `/children/${bear.body.child}`, { auth: a, body: { nickname: "Bea" } });
    assertEquals(ren.body.nickname, "Bea");
    assertEquals((await w.call("PATCH", `/children/${bear.body.child}`, { auth: b, body: { nickname: "Hacked" } })).status, 404);
    assertEquals((await w.call("DELETE", `/children/${bear.body.child}`, { auth: b })).status, 404);
    const fam = await w.call("GET", "/family", { auth: b });
    assertEquals(fam.body.children.length, 0, "B sees none of A's children");
  } finally {
    await w.close();
  }
});

Deno.test("pairing: code, approve, token handed over once", async () => {
  const w = await world();
  try {
    const a = await parentWithFamily(w, A);
    const s = await w.call("POST", "/devices/pair/start", { body: { game: "acorn-math", dev: "d_7f3a9c1e04b25d68", app: "0.24.0", code: 43 } });
    assertEquals(s.status, 201);
    assert(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(s.body.code), s.body.code);
    assertEquals(s.body.qr_url, `https://parents.example.invalid/pair/${s.body.code}`);
    const waiting = await w.call("GET", `/devices/pair/poll?pair_id=${s.body.pair_id}`);
    assertEquals(waiting.body.state, "waiting");
    assertEquals((await w.call("POST", "/devices/pair/approve", { auth: a, body: { code: "AAA-AAA" } })).status, 404, "wrong code");
    // typed in lower case with a space: still found
    const typed = s.body.code.toLowerCase().replace("-", " ");
    const ok = await w.call("POST", "/devices/pair/approve", { auth: a, body: { code: typed, device_name: "Kitchen tablet" } });
    assertEquals(ok.status, 200);
    assertEquals((await w.call("POST", "/devices/pair/approve", { auth: a, body: { code: s.body.code } })).status, 404, "a code works once");
    const got = await w.call("GET", `/devices/pair/poll?pair_id=${s.body.pair_id}`);
    assertEquals(got.body.state, "approved");
    assert(got.body.device_token.startsWith("dt_"));
    assertEquals((await w.call("GET", `/devices/pair/poll?pair_id=${s.body.pair_id}`)).status, 404, "the token is handed over once");
    const [row] = await w.deps.sql`select token_hash from devices`;
    assert(!row.token_hash.includes(got.body.device_token), "only a hash is stored");
    const fam = await w.call("GET", "/family", { auth: a });
    assertEquals(fam.body.devices.map((d: any) => [d.dev, d.name]), [["d_7f3a9c1e04b25d68", "Kitchen tablet"]]);
  } finally {
    await w.close();
  }
});

Deno.test("pairing: codes run out, and a tablet can't be taken from another family", async () => {
  const w = await world();
  try {
    const a = await parentWithFamily(w, A);
    const b = await parentWithFamily(w, B);
    const s = await w.call("POST", "/devices/pair/start", { body: { game: "acorn-math", dev: "d_0000000000000001" } });
    w.clock.ms += 11 * 60 * 1000;
    assertEquals((await w.call("POST", "/devices/pair/approve", { auth: a, body: { code: s.body.code } })).status, 404);
    assertEquals((await w.call("GET", `/devices/pair/poll?pair_id=${s.body.pair_id}`)).body.state, "expired");
    const dev = await pairedDevice(w, a, "d_0000000000000002");
    const s2 = await w.call("POST", "/devices/pair/start", { body: { game: "acorn-math", dev: "d_0000000000000002" } });
    assertEquals((await w.call("POST", "/devices/pair/approve", { auth: b, body: { code: s2.body.code } })).status, 409);
    // A removes it: the old token hears "gone", and B can now pair it
    assertEquals((await w.call("DELETE", "/devices/d_0000000000000002", { auth: a })).status, 200);
    assertEquals((await w.call("GET", "/children/c_000000000000/games/acorn-math/settings", { auth: dev })).status, 410);
    const s3 = await w.call("POST", "/devices/pair/start", { body: { game: "acorn-math", dev: "d_0000000000000002" } });
    assertEquals((await w.call("POST", "/devices/pair/approve", { auth: b, body: { code: s3.body.code } })).status, 200);
  } finally {
    await w.close();
  }
});

Deno.test("viewers read but don't pair or change", async () => {
  const w = await world();
  try {
    const a = await parentWithFamily(w, A);
    const fam = (await w.call("GET", "/family", { auth: a })).body.family;
    await w.deps.sql`insert into auth.users (id) values (${B})`;
    await w.deps.sql`insert into adults values (${B}, ${fam}, 'viewer')`;
    const v = `Bearer parent:${B}`;
    assertEquals((await w.call("GET", "/family", { auth: v })).status, 200);
    assertEquals((await w.call("POST", "/family/children", { auth: v, body: { nickname: "X" } })).status, 403);
    assertEquals((await w.call("DELETE", "/family", { auth: v })).status, 403);
  } finally {
    await w.close();
  }
});
