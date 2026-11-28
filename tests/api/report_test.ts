import { assert, assertEquals } from "jsr:@std/assert@1";
import { CRON_KEY, pairedDevice, parentWithFamily, PUBLISH_KEY, sample, sampleLines, world, type World } from "./helpers.ts";
import type { Mail } from "../../supabase/functions/_shared/deps.ts";
import { clearedText, gameReport, sessions, weeklyEmail } from "../../supabase/functions/_shared/report.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const C = "00000000-0000-4000-8000-00000000000c";
const DEV = "d_7f3a9c1e04b25d68";
const P1 = "p_04a2c9e1f3b7";

const ANSWER = sampleLines()[2];
const EVENT = sampleLines()[1];

function answer(seq: number, t: number, q: string, right: boolean, secs: number, skill = "add.within6") {
  return { ...ANSWER, dev: DEV, profile: P1, seq, t, q, right, pick: right ? ANSWER.answer : ANSWER.answer - 1, secs, skill };
}
function event(seq: number, t: number, name: string, extra: Record<string, unknown> = {}) {
  return { ...EVENT, dev: DEV, profile: P1, seq, t, event: name, ...extra };
}

async function setup(w: World) {
  const parent = await parentWithFamily(w, A, "parent@example.invalid");
  const bear = (await w.call("POST", "/family/children", { auth: parent, body: { nickname: "Bear" } })).body.child;
  const dev = await pairedDevice(w, parent, DEV);
  await w.call("PUT", `/devices/${DEV}/profiles`, { auth: dev, body: { profiles: [{ profile: P1, child: bear, nickname: "Bear", picture: "fox" }] } });
  const m = sample("manifest.json");
  assertEquals((await w.call("PUT", `/games/acorn-math/manifests/${m.code}`, { auth: `Publisher ${PUBLISH_KEY}`, body: m })).status, 201);
  const now = Math.floor(w.clock.ms / 1000);
  const t0 = now - 2 * 86400; // two days ago
  const log = [
    event(1, t0, "run_start", { world: "lava_caves", level_id: 1 }),
    answer(2, t0 + 10, "3 + 2 = ?", true, 2),
    answer(3, t0 + 20, "4 + 2 = ?", false, 3),
    answer(4, t0 + 30, "4 + 2 = ?", true, 20), // right but slow
    answer(5, t0 + 40, "1 + 1 = ?", true, 1, "count.to6"),
    event(6, t0 + 300, "level_cleared", { world: "lava_caves", level_id: 12, level: 2 }),
    // a second session the next day
    answer(7, t0 + 86400, "5 + 1 = ?", true, 2),
    event(8, t0 + 86400 + 120, "boss_won", { world: "lava_caves" }),
  ];
  const text = log.map((l) => JSON.stringify(l)).join("\n");
  const up = await w.call("PUT", `/events/acorn-math/${DEV}/1-8`, { auth: dev, raw: new TextEncoder().encode(text) });
  assertEquals(up.status, 201, JSON.stringify(up.body));
  const snap = { ...sample("snapshot.json"), dev: DEV, profile: P1, child: bear, rev: 5, saved_at: now };
  snap.save = { ...snap.save, marks: { lava_caves: [1, 12, 13, 14, 15, 16], crystal_mines: [21] }, difficulty: 2 };
  assertEquals((await w.call("PUT", `/children/${bear}/games/acorn-math/snapshots/${DEV}`, { auth: dev, body: snap })).status, 200);
  return { parent, bear, dev, now, t0 };
}

Deno.test("report: one section per game with time, sums, levels and worlds", async () => {
  const w = await world();
  try {
    const { parent, bear, dev, now, t0 } = await setup(w);
    const r = await w.call("GET", `/children/${bear}/report?days=7`, { auth: parent });
    assertEquals(r.status, 200, JSON.stringify(r.body));
    assertEquals(r.body.nickname, "Bear");
    assertEquals(r.body.games.length, 1);
    const g = r.body.games[0];
    assertEquals(g.game, "acorn-math");
    assertEquals(g.title, "Acorn Mathematics");
    assertEquals(g.answers, 5);
    assertEquals(g.right, 4);
    assertEquals(g.right_pct, 80);
    assertEquals(g.sessions.length, 2, "a day apart: two sessions");
    assertEquals(g.days_played, 2);
    assertEquals(g.minutes, 5 + 2);
    assertEquals(g.levels_cleared, 1);
    assertEquals(g.cleared[0].label, "Lava Caves");
    assertEquals(g.cleared[0].num, 2, "level id 12 is Lava Caves level 2 in the manifest");
    assertEquals(g.bosses_won, 1);
    assertEquals(g.slow, 1);
    assertEquals(g.practice[0].q, "4 + 2 = ?", "missed and slow: practise first");
    assertEquals(g.by_skill[0].label, "Add two numbers, total up to 6");
    assertEquals(g.progress.level_setting, 2);
    assertEquals(g.progress.worlds_complete, ["Lava Caves"]);
    assertEquals(g.progress.worlds.find((x: any) => x.world === "crystal_mines").done, 1);
    // a range: only the second day
    const day2 = await w.call("GET", `/children/${bear}/report?from=${t0 + 3600}&to=${now}`, { auth: parent });
    assertEquals(day2.body.games[0].answers, 1);
    // checks
    assertEquals((await w.call("GET", `/children/${bear}/report`, { auth: dev })).status, 403, "reports are for parents");
    assertEquals((await w.call("GET", `/children/${bear}/report?from=10&to=5`, { auth: parent })).status, 400);
    const other = await parentWithFamily(w, C);
    assertEquals((await w.call("GET", `/children/${bear}/report`, { auth: other })).status, 404);
  } finally {
    await w.close();
  }
});

Deno.test("weekly email: preview, settings, test send, the weekly job sends once", async () => {
  const w = await world();
  const sent: Mail[] = [];
  try {
    const { parent } = await setup(w);
    // without a mail account: previews work, nothing sends
    const me = await w.call("GET", "/family/me", { auth: parent });
    assertEquals(me.body.weekly_email, true);
    assertEquals(me.body.mail_on, false);
    assertEquals(me.body.email, "parent@example.invalid");
    const pv = await w.call("GET", "/family/weekly-email", { auth: parent });
    assertEquals(pv.status, 200);
    assert(pv.body.subject.includes("Bear"));
    assert(pv.body.text.includes("Acorn Mathematics"));
    assert(pv.body.text.includes("4 + 2"), "the sum to practise");
    assert(pv.body.html.includes("Levels finished"));
    assertEquals((await w.call("POST", "/family/weekly-email/test", { auth: parent })).body.reason, "mail_off");
    const off = await w.call("POST", "/admin/weekly", { auth: `Cron ${CRON_KEY}` });
    assertEquals(off.body, { mail_on: false, due: 1, sent: 0, failed: 0 });
    assertEquals((await w.call("POST", "/admin/weekly")).status, 401);
    // time zone
    assertEquals((await w.call("PATCH", "/family/me", { auth: parent, body: { tz: "Mars/Olympus" } })).status, 400);
    assertEquals((await w.call("PATCH", "/family/me", { auth: parent, body: { tz: "America/Toronto" } })).body.tz, "America/Toronto");
    // with one
    w.deps.mail = (m) => {
      sent.push(m);
      return Promise.resolve();
    };
    const t = await w.call("POST", "/family/weekly-email/test", { auth: parent });
    assertEquals(t.body, { sent: true, to: "parent@example.invalid" });
    assertEquals((await w.call("POST", "/family/weekly-email/test", { auth: parent })).status, 429, "one test per 10 minutes");
    const on = await w.call("POST", "/admin/weekly", { auth: `Cron ${CRON_KEY}` });
    assertEquals(on.body.sent, 1);
    assertEquals((await w.call("POST", "/admin/weekly", { auth: `Cron ${CRON_KEY}` })).body.due, 0, "fired twice: sent once");
    w.clock.ms += 7 * 86400_000;
    assertEquals((await w.call("POST", "/admin/weekly", { auth: `Cron ${CRON_KEY}` })).body.sent, 1, "next week again");
    // turned off
    await w.call("PATCH", "/family/me", { auth: parent, body: { weekly_email: false } });
    w.clock.ms += 7 * 86400_000;
    assertEquals((await w.call("POST", "/admin/weekly", { auth: `Cron ${CRON_KEY}` })).body.due, 0);
    assertEquals(sent.length, 3);
    assertEquals(sent[0].to, "parent@example.invalid");
  } finally {
    await w.close();
  }
});

Deno.test("report pieces: sessions split on gaps and devices; empty week reads well", () => {
  const l = (t: number, dev = DEV) => ({ kind: "event", event: "x", t, dev });
  assertEquals(sessions([l(0), l(100), l(800), l(900, "d_0000000000000001")]).length, 3);
  const g = gameReport("acorn-math", [], [], null, {});
  assertEquals(g.answers, 0);
  assertEquals(g.progress, null);
  const noList = gameReport("x-game", [], [{ saved_at: 1, save: { marks: { w: [1, 2] } } }], null, {});
  assertEquals(noList.progress!.worlds[0].complete, false, "without the level list, never claim a world is complete");
  const e = weeklyEmail({ children: [{ child: "c_000000000001", nickname: "Wren", games: [g] }], from: 0, to: 7 * 86400, tz: "Nope/Nowhere" });
  assert(e.text.includes("No play this week."));
  const lv = (label: string, num: number) => ({ world: "", label, num, id: null, at: 0 });
  assertEquals(clearedText([lv("Lava Caves", 2), lv("Lava Caves", 2), lv("Bog", 1)]), "Lava Caves 2 (2 times), Bog 1");
});
