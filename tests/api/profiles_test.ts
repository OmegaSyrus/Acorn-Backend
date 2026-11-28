// Profile plan C3 and C4 (2026-11-21): a paired tablet reads its profile map
// and the family's children again, and may make a family child itself.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { pairedDevice, parentWithFamily, world } from "./helpers.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const DEV_A = "d_00000000000000a1";
const DEV_B = "d_00000000000000b1";
const P1 = "p_000000000001";
const P2 = "p_000000000002";
const GUEST = "p_00000000000f";

Deno.test("C3: a child added after pairing shows up, and another family's tablet gets 403", async () => {
  const w = await world();
  try {
    const a = await parentWithFamily(w, A);
    const b = await parentWithFamily(w, B);
    const bear = await w.call("POST", "/family/children", { auth: a, body: { nickname: "Bear", picture: "fox" } });
    const tab = await pairedDevice(w, a, DEV_A);
    const other = await pairedDevice(w, b, DEV_B);

    const first = await w.call("GET", `/devices/${DEV_A}/profiles`, { auth: tab });
    assertEquals(first.status, 200);
    assertEquals(first.body.profiles, []);
    assertEquals(first.body.children, [{ child: bear.body.child, nickname: "Bear", picture: "fox" }]);

    const put = await w.call("PUT", `/devices/${DEV_A}/profiles`, {
      auth: tab,
      body: { profiles: [{ profile: P1, child: bear.body.child, nickname: "Bear", picture: "fox", guest: false }] },
    });
    assertEquals(put.status, 200);
    assertEquals(put.body.profiles.map((p: any) => [p.profile, p.child]), [[P1, bear.body.child]], "the old answer is still there");

    // the parent adds a child on the web after pairing
    const wren = await w.call("POST", "/family/children", { auth: a, body: { nickname: "Wren", picture: "phoenix" } });
    const again = await w.call("GET", `/devices/${DEV_A}/profiles`, { auth: tab });
    assertEquals(again.body.children.map((c: any) => [c.nickname, c.picture]), [["Bear", "fox"], ["Wren", "phoenix"]]);
    assertEquals(again.body.profiles.length, 1);

    // and removes one: it leaves the list, the mapping stays with no child
    assertEquals((await w.call("DELETE", `/children/${bear.body.child}`, { auth: a })).status, 200);
    const after = await w.call("GET", `/devices/${DEV_A}/profiles`, { auth: tab });
    assertEquals(after.body.children.map((c: any) => c.child), [wren.body.child]);
    assertEquals(after.body.profiles.map((p: any) => [p.profile, p.child]), [[P1, null]]);

    // another family's tablet, no token, and a parent token can't read it
    const theirs = await w.call("GET", `/devices/${DEV_A}/profiles`, { auth: other });
    assertEquals(theirs.status, 403);
    assertEquals(theirs.body.error, "forbidden");
    assertEquals((await w.call("GET", `/devices/${DEV_A}/profiles`)).status, 401);
    assertEquals((await w.call("GET", `/devices/${DEV_A}/profiles`, { auth: a })).status, 401);
    // a removed tablet hears "gone"
    assertEquals((await w.call("DELETE", `/devices/${DEV_A}`, { auth: a })).status, 200);
    assertEquals((await w.call("GET", `/devices/${DEV_A}/profiles`, { auth: tab })).status, 410);
  } finally {
    await w.close();
  }
});

Deno.test("C4: one call makes and maps the child, and sending it again makes no second child", async () => {
  const w = await world();
  try {
    const a = await parentWithFamily(w, A);
    const tab = await pairedDevice(w, a, DEV_A);
    const body = {
      profiles: [
        { profile: P1, child: "new", nickname: " Bear ", picture: "phoenix", guest: false },
        { profile: GUEST, child: "new", nickname: "Guest", picture: "slime_knight", guest: true },
      ],
    };
    const r = await w.call("PUT", `/devices/${DEV_A}/profiles`, { auth: tab, body });
    assertEquals(r.status, 200);
    assertEquals(r.body.created.length, 1, "a Guest never becomes a child");
    const made = r.body.created[0];
    assertEquals(made.profile, P1);
    assert(/^c_[0-9a-f]{12}$/.test(made.child), made.child);
    assertEquals(r.body.children, [{ child: made.child, nickname: "Bear", picture: "phoenix" }]);
    const byProfile = Object.fromEntries(r.body.profiles.map((p: any) => [p.profile, p.child]));
    assertEquals(byProfile, { [P1]: made.child, [GUEST]: null });

    // the parent sees the child the tablet made
    const fam = await w.call("GET", "/family", { auth: a });
    assertEquals(fam.body.children.map((c: any) => [c.child, c.nickname, c.picture]), [[made.child, "Bear", "phoenix"]]);

    // sent again (a retry after a lost answer): same child, nothing new
    const again = await w.call("PUT", `/devices/${DEV_A}/profiles`, { auth: tab, body });
    assertEquals(again.status, 200);
    assertEquals(again.body.created, []);
    assertEquals(again.body.profiles.find((p: any) => p.profile === P1).child, made.child);
    const [{ n }] = await w.deps.sql`select count(*)::int as n from children`;
    assertEquals(n, 1);

    // the same profile twice in one call makes one child
    const twice = await w.call("PUT", `/devices/${DEV_A}/profiles`, {
      auth: tab,
      body: { profiles: [{ profile: P2, child: "new", nickname: "Wren" }, { profile: P2, child: "new", nickname: "Wren" }] },
    });
    assertEquals(twice.body.created.length, 1);
    assertEquals(twice.body.children.length, 2);
    assertEquals(twice.body.created[0].child, twice.body.profiles.find((p: any) => p.profile === P2).child);
    // with no picture the child gets the default
    assertEquals(twice.body.children[1].picture, "fox");
  } finally {
    await w.close();
  }
});

Deno.test("C4: a new child needs a nickname, and past 12 children it answers 409 with nothing changed", async () => {
  const w = await world();
  try {
    const a = await parentWithFamily(w, A);
    const tab = await pairedDevice(w, a, DEV_A);
    const put = (profiles: unknown[]) => w.call("PUT", `/devices/${DEV_A}/profiles`, { auth: tab, body: { profiles } });
    assertEquals((await put([{ profile: P1, child: "new", nickname: "  " }])).status, 400);
    assertEquals((await put([{ profile: P1, child: "new" }])).status, 400);
    assertEquals((await put([{ profile: P1, child: "new", nickname: "Bear", picture: "Not OK" }])).status, 400);
    assertEquals((await put([{ profile: P1, child: "new", nickname: "x".repeat(25) }])).status, 400);

    for (let i = 0; i < 11; i++) {
      assertEquals((await w.call("POST", "/family/children", { auth: a, body: { nickname: `Kid ${i}` } })).status, 201);
    }
    // the 12th child: allowed
    const twelfth = await put([{ profile: P1, child: "new", nickname: "Bear" }]);
    assertEquals(twelfth.status, 200);
    assertEquals(twelfth.body.children.length, 12);
    // a 13th: 409, and the other item in the same call is not written either
    const full = await put([
      { profile: GUEST, guest: true, nickname: "Guest", picture: "slime_knight" },
      { profile: P2, child: "new", nickname: "Wren" },
    ]);
    assertEquals(full.status, 409);
    assertEquals(full.body.reason, "children_limit");
    assertEquals(full.body.profile, P2);
    const now = await w.call("GET", `/devices/${DEV_A}/profiles`, { auth: tab });
    assertEquals(now.body.children.length, 12);
    assertEquals(now.body.profiles.map((p: any) => p.profile), [P1], "the call changed nothing");
    // the profile that already has its child still sends "new" without a 409
    assertEquals((await put([{ profile: P1, child: "new", nickname: "Bear" }])).status, 200);
  } finally {
    await w.close();
  }
});
