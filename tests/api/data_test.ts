import { assert, assertEquals } from "jsr:@std/assert@1";
import { CRON_KEY, gunzipText, gzip, pairedDevice, parentWithFamily, PUBLISH_KEY, sample, sampleLines, world, type World } from "./helpers.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const DEV = "d_7f3a9c1e04b25d68";
const P1 = "p_04a2c9e1f3b7";
const P2 = "p_91c0d2e4a6b8";

/** A family with two children on one paired tablet, profiles mapped. */
async function family(w: World) {
  const parent = await parentWithFamily(w, A);
  const bear = (await w.call("POST", "/family/children", { auth: parent, body: { nickname: "Bear" } })).body.child;
  const wren = (await w.call("POST", "/family/children", { auth: parent, body: { nickname: "Wren" } })).body.child;
  const dev = await pairedDevice(w, parent, DEV);
  const r = await w.call("PUT", `/devices/${DEV}/profiles`, {
    auth: dev,
    body: { profiles: [
      { profile: P1, child: bear, nickname: "Bear", picture: "fox" },
      { profile: P2, child: wren, nickname: "Wren", picture: "bunny" },
      { profile: "p_5e5e00a1b2c3", child: bear, guest: true, nickname: "Guest" },
    ] },
  });
  assertEquals(r.status, 200);
  assertEquals(r.body.profiles.find((p: any) => p.guest).child, null, "a Guest never maps to a child");
  return { parent, dev, bear, wren };
}

function lines(first: number, profiles: string[]): string {
  const base = sampleLines()[2];
  return profiles.map((p, i) => JSON.stringify({ ...base, dev: DEV, profile: p, seq: first + i })).join("\n") + "\n";
}

Deno.test("events: gzip batches, duplicates, bad lines, play time", async () => {
  const w = await world();
  try {
    const { dev, bear, wren } = await family(w);
    // the contract's own sample log is accepted as it stands
    const sampleText = sampleLines().map((l) => JSON.stringify(l)).join("\n");
    const s = await w.call("PUT", `/events/acorn-math/${DEV}/10430-10435`, { auth: dev, raw: await gzip(sampleText), headers: { "content-encoding": "gzip" } });
    assertEquals(s.status, 201, JSON.stringify(s.body));
    assertEquals(s.body.lines, 6);
    assertEquals(s.body.children, [bear]);
    const again = await w.call("PUT", `/events/acorn-math/${DEV}/10430-10435`, { auth: dev, raw: await gzip(sampleText), headers: { "content-encoding": "gzip" } });
    assertEquals(again.body, { stored: false, duplicate: true, lines: 6 }, "sent twice is harmless");
    // plain text works too, and is stored compressed
    const two = await w.call("PUT", `/events/acorn-math/${DEV}/1-2`, { auth: dev, raw: new TextEncoder().encode(lines(1, [P1, P2])) });
    assertEquals(two.status, 201);
    assertEquals(two.body.children.sort(), [bear, wren].sort());
    const stored = w.deps.blobs.files.get(`events/${(await w.deps.sql`select id from families`)[0].id}/acorn-math/${DEV}/1-2.jsonl.gz`)!;
    assert((await gunzipText(stored)).includes(P2));
    // unknown profiles are kept and reported
    const odd = await w.call("PUT", `/events/acorn-math/${DEV}/3-3`, { auth: dev, raw: new TextEncoder().encode(lines(3, ["p_00000000000f"])) });
    assertEquals(odd.body.unmapped_profiles, ["p_00000000000f"]);
    // bad batches
    const bad = (text: string, range = "4-4") => w.call("PUT", `/events/acorn-math/${DEV}/${range}`, { auth: dev, raw: new TextEncoder().encode(text) });
    assertEquals((await bad("not json")).status, 400);
    assertEquals((await bad(lines(9, [P1]))).status, 400, "seq outside the range");
    assertEquals((await bad(lines(4, [P1]).replace(DEV, "d_0000000000000000"))).status, 400, "another device's line");
    assertEquals((await bad(JSON.stringify({ ...JSON.parse(lines(4, [P1])), skill: undefined }))).status, 400, "a v2 answer without a skill");
    assertEquals((await bad('{"v":1,"t":1,"kind":"event","event":"x"}')).status, 201, "old version 1 lines are still stored");
    assertEquals((await w.call("PUT", `/events/acorn-math/d_0000000000000000/5-5`, { auth: dev, raw: new TextEncoder().encode("{}") })).status, 403);
    assertEquals((await w.call("PUT", `/events/other-game/${DEV}/5-5`, { auth: dev, raw: new TextEncoder().encode("{}") })).status, 403);
    assertEquals((await w.call("PUT", `/events/acorn-math/${DEV}/5-5`, { auth: "Device dt_nope", raw: new TextEncoder().encode("{}") })).status, 401);
    const [c] = await w.deps.sql`select last_play_at from children where id = ${bear}`;
    assert(c.last_play_at, "last play recorded");
  } finally {
    await w.close();
  }
});

Deno.test("snapshots: newest per device, only the family reads them", async () => {
  const w = await world();
  try {
    const { parent, dev, bear } = await family(w);
    const snap = { ...sample("snapshot.json"), dev: DEV, child: null, rev: 5 };
    const put = (s: unknown, auth = dev) => w.call("PUT", `/children/${bear}/games/acorn-math/snapshots/${DEV}`, { auth, body: s });
    assertEquals((await put(snap)).status, 200);
    assertEquals((await put(snap)).status, 409, "same rev again");
    assertEquals((await put({ ...snap, rev: 4 })).body.stored_rev, 5, "older is refused with the stored rev");
    assertEquals((await put({ ...snap, rev: 6, save: { ...snap.save, gems: 99 } })).status, 200);
    assertEquals((await put({ ...snap, rev: 7, schema: "nope" })).status, 400, "checked against the contract");
    assertEquals((await put({ ...snap, rev: 7, dev: "d_0000000000000000" })).status, 400);
    const got = await w.call("GET", `/children/${bear}/games/acorn-math/snapshots`, { auth: dev });
    assertEquals(got.body.snapshots.length, 1);
    assertEquals(got.body.snapshots[0].save.gems, 99);
    assertEquals(got.body.snapshots[0].child, bear, "the server files it under the child");
    assertEquals((await w.call("GET", `/children/${bear}/games/acorn-math/snapshots`, { auth: parent })).status, 200, "parents read too");
    // another family
    const other = await parentWithFamily(w, B);
    const otherDev = await pairedDevice(w, other, "d_00000000000000bb");
    assertEquals((await w.call("GET", `/children/${bear}/games/acorn-math/snapshots`, { auth: other })).status, 404);
    assertEquals((await w.call("GET", `/children/${bear}/games/acorn-math/snapshots`, { auth: otherDev })).status, 404);
    assertEquals((await put({ ...snap, rev: 9 }, otherDev)).status, 404);
  } finally {
    await w.close();
  }
});

Deno.test("settings: from the manifest, latest change wins", async () => {
  const w = await world();
  try {
    const { parent, dev, bear } = await family(w);
    const manifest = {
      ...sample("manifest.json"),
      code: 43,
      settings: [
        { key: "daily_minutes", type: "int", min: 0, max: 120, default: 0, label: "Daily time limit", since_code: 43 },
        { key: "no_play_after", type: "time", default: null, label: "No play after", since_code: 43 },
        { key: "volume", type: "int", min: 0, max: 10, default: 8, label: "Volume", since_code: 43, scope: "device" },
      ],
    };
    assertEquals((await w.call("PUT", "/games/acorn-math/manifests/43", { body: manifest })).status, 401, "publisher key needed");
    assertEquals((await w.call("PUT", "/games/acorn-math/manifests/43", { auth: `Publisher ${PUBLISH_KEY}`, body: { ...manifest, skills: ["nope"] } })).status, 400);
    assertEquals((await w.call("PUT", "/games/acorn-math/manifests/43", { auth: `Publisher ${PUBLISH_KEY}`, body: manifest })).status, 201);
    assertEquals((await w.call("GET", "/games/acorn-math/manifests/latest")).body.code, 43);
    const url = `/children/${bear}/games/acorn-math/settings`;
    const empty = await w.call("GET", url, { auth: dev });
    assertEquals(empty.body, { schema: "family.settings", v: 1, child: bear, game: "acorn-math", rev: 0, fields: {} });
    const p1 = await w.call("PATCH", url, { auth: parent, body: { fields: { daily_minutes: { value: 30 } } } });
    assertEquals(p1.body.fields.daily_minutes, { value: 30, rev: 1, at: w.clock.ms / 1000, by: "parent" });
    w.clock.ms += 1000;
    const p2 = await w.call("PATCH", url, { auth: dev, body: { fields: { daily_minutes: { value: 45 }, no_play_after: { value: "19:30" } } } });
    assertEquals(p2.body.rev, 2);
    assertEquals(p2.body.fields.daily_minutes.by, `device:${DEV}`, "the tablet's change is the latest");
    assertEquals(p2.body.fields.daily_minutes.value, 45);
    assertEquals((await w.call("PATCH", url, { auth: parent, body: { fields: { level: { value: 3 } } } })).status, 422, "no remote Level");
    assertEquals((await w.call("PATCH", url, { auth: parent, body: { fields: { volume: { value: 3 } } } })).status, 422, "device settings never sync");
    assertEquals((await w.call("PATCH", url, { auth: parent, body: { fields: { daily_minutes: { value: 500 } } } })).status, 422);
    assertEquals((await w.call("PATCH", url, { auth: parent, body: { fields: { no_play_after: { value: "25:00" } } } })).status, 422);
    const doc = (await w.call("GET", url, { auth: parent })).body;
    const errs = (await import("../../supabase/functions/_shared/schema.ts")).schemaErrors(doc, (await import("../../supabase/functions/_shared/contract.ts")).SCHEMAS.settings_v1);
    assertEquals(errs, [], "the settings document matches the contract");
  } finally {
    await w.close();
  }
});

Deno.test("export has everything; deleting a child keeps a sibling's lines; deleting the family empties storage", async () => {
  const w = await world();
  try {
    const { parent, dev, bear, wren } = await family(w);
    await w.call("PUT", `/events/acorn-math/${DEV}/1-3`, { auth: dev, raw: new TextEncoder().encode(lines(1, [P1, P2, P1])) });
    await w.call("PUT", `/events/acorn-math/${DEV}/4-4`, { auth: dev, raw: new TextEncoder().encode(lines(4, [P1])) });
    await w.call("PUT", `/children/${bear}/games/acorn-math/snapshots/${DEV}`, { auth: dev, body: { ...sample("snapshot.json"), dev: DEV, child: null } });
    const ex = await w.call("GET", "/family/export", { auth: parent });
    assertEquals(ex.body.schema, "family.export");
    assertEquals(ex.body.children.length, 2);
    assertEquals(ex.body.events.reduce((n: number, e: any) => n + e.lines.length, 0), 4);
    assertEquals(ex.body.snapshots.length, 1);
    assertEquals(ex.body.consents.length, 1);
    assertEquals((await w.call("DELETE", `/children/${bear}`, { auth: parent })).status, 200);
    const left = await w.call("GET", "/family/export", { auth: parent });
    assertEquals(left.body.children.map((c: any) => c.child), [wren]);
    assertEquals(left.body.snapshots.length, 0, "Bear's snapshot is gone");
    const kept = left.body.events.flatMap((e: any) => e.lines.map((l: any) => l.profile));
    assertEquals(kept, [P2], "only Wren's line is left, in the shared batch");
    assertEquals(w.deps.blobs.files.size, 1);
    assertEquals((await w.call("DELETE", "/family", { auth: parent })).status, 200);
    assertEquals(w.deps.blobs.files.size, 0, "storage emptied");
    assertEquals((await w.deps.sql`select count(*)::int as n from devices`)[0].n, 0);
    assertEquals((await w.call("GET", `/children/${wren}/games/acorn-math/settings`, { auth: dev })).status, 401, "the tablet's token no longer works");
  } finally {
    await w.close();
  }
});

Deno.test("retention: 24 months after last play, idle families warned then deleted", async () => {
  const w = await world();
  try {
    const { dev } = await family(w);
    await w.call("PUT", `/events/acorn-math/${DEV}/1-1`, { auth: dev, raw: new TextEncoder().encode(lines(1, [P1])) });
    const run = () => w.call("POST", "/admin/retention", { auth: `Cron ${CRON_KEY}` });
    assertEquals((await w.call("POST", "/admin/retention", { auth: "Cron wrong" })).status, 401);
    assertEquals((await run()).body, { batches_deleted: 0, families_warned: 0, families_deleted: 0 });
    w.clock.ms += 23 * 30 * 86400_000;
    assertEquals((await run()).body.batches_deleted, 0, "kept at 23 months");
    w.clock.ms += 2 * 30 * 86400_000;
    const r = await run();
    assertEquals(r.body, { batches_deleted: 1, families_warned: 1, families_deleted: 0 }, "at 25 months the batch goes and the family is warned");
    assertEquals(w.deps.blobs.files.size, 0);
    w.clock.ms += 31 * 86400_000;
    assertEquals((await run()).body.families_deleted, 1, "deleted after 30 more days idle");
    assertEquals((await w.deps.sql`select count(*)::int as n from families`)[0].n, 0);
  } finally {
    await w.close();
  }
});

Deno.test("health and unknown routes", async () => {
  const w = await world();
  try {
    assertEquals((await w.call("GET", "/health")).body, { ok: true, api: "v1" });
    assertEquals((await w.call("GET", "/nope")).status, 404);
    assertEquals((await w.call("OPTIONS", "/family")).status, 204);
  } finally {
    await w.close();
  }
});

Deno.test("records: a parent reads one child's lines, newest first; mapping later counts", async () => {
  const w = await world();
  try {
    const { parent, dev, bear, wren } = await family(w);
    const LATE = "p_77777777777a";
    await w.call("PUT", `/events/acorn-math/${DEV}/1-3`, { auth: dev, raw: new TextEncoder().encode(lines(1, [P1, P2, LATE])) });
    w.clock.ms += 60_000;
    await w.call("PUT", `/events/acorn-math/${DEV}/4-5`, { auth: dev, raw: new TextEncoder().encode(lines(4, [P1, P1])) });
    const r = await w.call("GET", `/children/${bear}/games/acorn-math/records`, { auth: parent });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.lines.map((l: any) => l.seq), [5, 4, 1], "only Bear's lines, newest first");
    assertEquals(r.body.truncated, false);
    const capped = await w.call("GET", `/children/${bear}/games/acorn-math/records?limit=2`, { auth: parent });
    assertEquals(capped.body.lines.length, 2);
    assertEquals(capped.body.truncated, true);
    // a profile mapped after its lines were sent: its old lines count now
    await w.call("PUT", `/devices/${DEV}/profiles`, { auth: dev, body: { profiles: [{ profile: LATE, child: wren, nickname: "Wren 2" }] } });
    const wr = await w.call("GET", `/children/${wren}/games/acorn-math/records`, { auth: parent });
    assertEquals(wr.body.lines.map((l: any) => l.seq).sort(), [2, 3]);
    // older than the window: left out
    w.clock.ms += 3 * 86400_000;
    assertEquals((await w.call("GET", `/children/${bear}/games/acorn-math/records?days=1`, { auth: parent })).body.lines, []);
    // devices and other families can't read them
    assertEquals((await w.call("GET", `/children/${bear}/games/acorn-math/records`, { auth: dev })).status, 403);
    const other = await parentWithFamily(w, B);
    assertEquals((await w.call("GET", `/children/${bear}/games/acorn-math/records`, { auth: other })).status, 404);
    assertEquals((await w.call("GET", `/children/${bear}/games/acorn-math/records?days=0`, { auth: parent })).status, 400);
  } finally {
    await w.close();
  }
});
