// Reports (parent app plan v2, thread 6): one child's play in a period, one
// section per game, built from the play log lines, the latest save snapshots
// and the game's manifest. Pure functions, so the weekly email, the parent
// app's summary and the printable record all say the same thing.

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

/** A gap longer than this between lines starts a new play session. */
export const SESSION_GAP_SECS = 600;
/** Slow: at least this long, and at least twice the child's usual time. */
export const SLOW_MIN_SECS = 8;

export interface Session {
  start: number;
  end: number;
  minutes: number;
  answers: number;
  right: number;
  worlds: string[];
}

export interface GameReport {
  game: string;
  title: string;
  minutes: number;
  days_played: number;
  answers: number;
  right: number;
  right_pct: number;
  avg_secs: number;
  slow_secs: number;
  slow: number;
  levels_cleared: number;
  fights_won: number;
  bosses_won: number;
  restarts: number;
  by_skill: { skill: string; label: string; tries: number; right: number; right_pct: number; avg_secs: number }[];
  by_where: { where: string; label: string; tries: number; right: number; right_pct: number }[];
  /** Sums to practise: missed at least once, or right but slow. Worst first. */
  practice: { q: string; skill: string; tries: number; missed: number; slow: number; avg_secs: number }[];
  sessions: Session[];
  /** Levels finished in this period, in play order. */
  cleared: { world: string; label: string; num: number | null; id: number | null; at: number }[];
  /** All-time progress from the save snapshots (every device merged). */
  progress: {
    level_setting: number | null;
    worlds: { world: string; label: string; done: number; total: number; stars: number; complete: boolean }[];
    worlds_complete: string[];
  } | null;
}

export const WHERE_LABELS: Record<string, string> = {
  stone: "Stepping stones",
  fight: "Fights",
  duel: "Miniboss duels",
  boss: "Boss fights",
};

export function pct(a: number, b: number): number {
  return b ? Math.round((100 * a) / b) : 0;
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Play sessions, newest first. A new device or a 10-minute gap starts one. */
export function sessions(lines: Row[], labels: Record<string, string> = {}): Session[] {
  const sorted = lines.filter((l) => typeof l.t === "number").sort((a, b) => a.t - b.t || (a.seq ?? 0) - (b.seq ?? 0));
  const raw: { start: number; end: number; dev: string; lines: Row[] }[] = [];
  for (const l of sorted) {
    const cur = raw[raw.length - 1];
    if (!cur || l.t - cur.end > SESSION_GAP_SECS || l.dev !== cur.dev) raw.push({ start: l.t, end: l.t, dev: l.dev, lines: [l] });
    else {
      cur.end = l.t;
      cur.lines.push(l);
    }
  }
  return raw.reverse().map((s) => {
    const a = s.lines.filter((l) => l.kind === "answer");
    return {
      start: s.start,
      end: s.end,
      minutes: Math.max(1, Math.round((s.end - s.start) / 60)),
      answers: a.length,
      right: a.filter((l) => l.right === true).length,
      worlds: [...new Set(s.lines.map((l) => l.world).filter((w) => typeof w === "string"))].map((w) => labels[w] ?? w),
    };
  });
}

/** Merges every device's save into the all-time picture the report needs. */
function progressFrom(snapshots: Row[], manifest: Row | null): GameReport["progress"] {
  if (!snapshots.length) return null;
  const marks: Record<string, Set<number>> = {};
  const stars: Record<string, Set<number>> = {};
  let newest: Row | null = null;
  for (const s of snapshots) {
    const save = s?.save ?? {};
    for (const [w, ids] of Object.entries(save.marks ?? {})) {
      for (const id of Array.isArray(ids) ? ids : []) if (Number.isInteger(id)) (marks[w] ??= new Set()).add(id as number);
    }
    for (const [w, ids] of Object.entries(save.stars ?? {})) {
      for (const id of Array.isArray(ids) ? ids : []) if (Number.isInteger(id)) (stars[w] ??= new Set()).add(id as number);
    }
    if (!newest || (s.saved_at ?? 0) > (newest.saved_at ?? 0)) newest = s;
  }
  const labels: Record<string, string> = manifest?.labels ?? {};
  const levels: Row[] = Array.isArray(manifest?.levels) ? manifest!.levels : [];
  const worldIds = levels.length ? [...new Set(levels.map((l) => l.world as string))] : Object.keys(marks);
  const worlds = worldIds.map((w) => {
    const ids = levels.filter((l) => l.world === w).map((l) => l.id as number);
    const got = marks[w] ?? new Set<number>();
    const done = ids.length ? ids.filter((id) => got.has(id)).length : got.size;
    const total = ids.length || got.size;
    return { world: w, label: labels[w] ?? w, done, total, stars: (stars[w] ?? new Set()).size, complete: total > 0 && done >= total };
  });
  const lv = newest?.save?.difficulty;
  return {
    level_setting: Number.isInteger(lv) ? lv : null,
    worlds,
    worlds_complete: worlds.filter((w) => w.complete).map((w) => w.label),
  };
}

/** One game's section of a child's report. `lines` are that game's play log lines in the period. */
export function gameReport(game: string, lines: Row[], snapshots: Row[], manifest: Row | null, skillLabels: Record<string, string>): GameReport {
  const labels: Record<string, string> = manifest?.labels ?? {};
  const levelNum = new Map<number, number>();
  for (const l of manifest?.levels ?? []) levelNum.set(l.id, l.num);
  const answers = lines.filter((l) => l.kind === "answer");
  const times = answers.map((a) => Number(a.secs)).filter((x) => Number.isFinite(x) && x >= 0);
  const slowSecs = Math.max(SLOW_MIN_SECS, round1(2 * median(times)));
  const isSlow = (a: Row) => Number(a.secs) >= slowSecs;
  const right = answers.filter((a) => a.right === true).length;

  const skill: Record<string, { tries: number; right: number; secs: number }> = {};
  const where: Record<string, { tries: number; right: number }> = {};
  const qs: Record<string, { q: string; skill: string; tries: number; missed: number; slow: number; secs: number }> = {};
  for (const a of answers) {
    const sk = typeof a.skill === "string" ? a.skill : "unknown";
    const s = (skill[sk] ??= { tries: 0, right: 0, secs: 0 });
    s.tries++;
    s.right += a.right === true ? 1 : 0;
    s.secs += Number(a.secs) || 0;
    const w = (where[a.where ?? "other"] ??= { tries: 0, right: 0 });
    w.tries++;
    w.right += a.right === true ? 1 : 0;
    if (typeof a.q === "string" && a.q) {
      const k = `${sk}|${a.q}`;
      const e = (qs[k] ??= { q: a.q, skill: sk, tries: 0, missed: 0, slow: 0, secs: 0 });
      e.tries++;
      if (a.right !== true) e.missed++;
      else if (isSlow(a)) e.slow++;
      e.secs += Number(a.secs) || 0;
    }
  }
  const ses = sessions(lines, labels);
  const ev = (name: string) => lines.filter((l) => l.kind === "event" && l.event === name);
  const cleared = ev("level_cleared").sort((a, b) => (a.t ?? 0) - (b.t ?? 0)).map((l) => ({
    world: l.world ?? "",
    label: labels[l.world] ?? l.world ?? "",
    num: Number.isInteger(l.level_id) && levelNum.has(l.level_id) ? levelNum.get(l.level_id)! : (Number.isInteger(l.level) ? l.level : null),
    id: Number.isInteger(l.level_id) ? l.level_id : null,
    at: l.t ?? 0,
  }));
  return {
    game,
    title: manifest?.title ?? game,
    minutes: ses.reduce((m, s) => m + s.minutes, 0),
    days_played: new Set(ses.map((s) => Math.floor(s.start / 86400))).size,
    answers: answers.length,
    right,
    right_pct: pct(right, answers.length),
    avg_secs: times.length ? round1(times.reduce((a, b) => a + b, 0) / times.length) : 0,
    slow_secs: slowSecs,
    slow: answers.filter((a) => a.right === true && isSlow(a)).length,
    levels_cleared: cleared.length,
    fights_won: ev("fight_won").length,
    bosses_won: ev("boss_won").length,
    restarts: ev("restart").length,
    by_skill: Object.entries(skill).sort((a, b) => b[1].tries - a[1].tries).map(([id, v]) => ({
      skill: id,
      label: skillLabels[id] ?? id,
      tries: v.tries,
      right: v.right,
      right_pct: pct(v.right, v.tries),
      avg_secs: v.tries ? round1(v.secs / v.tries) : 0,
    })),
    by_where: Object.entries(where).map(([id, v]) => ({ where: id, label: WHERE_LABELS[id] ?? id, tries: v.tries, right: v.right, right_pct: pct(v.right, v.tries) })),
    practice: Object.values(qs).filter((e) => e.missed || e.slow)
      .sort((a, b) => b.missed - a.missed || b.slow - a.slow || b.secs / b.tries - a.secs / a.tries)
      .slice(0, 8)
      .map((e) => ({ q: e.q, skill: e.skill, tries: e.tries, missed: e.missed, slow: e.slow, avg_secs: round1(e.secs / e.tries) })),
    sessions: ses.slice(0, 60),
    cleared,
    progress: progressFrom(snapshots, manifest),
  };
}

// ------------------------------------------------------------------ the weekly email

export interface ChildReport {
  child: string;
  nickname: string;
  games: GameReport[];
}

function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function fmtDay(t: number, tz: string): string {
  return new Date(t * 1000).toLocaleDateString("en-CA", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
}

function fmtTime(t: number, tz: string): string {
  return new Date(t * 1000).toLocaleTimeString("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" });
}

export function safeTz(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

function minutesText(m: number): string {
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The weekly email for one adult: subject, plain text and HTML. */
export function weeklyEmail(o: { children: ChildReport[]; from: number; to: number; tz: string; appUrl?: string; warnIdle?: boolean }): {
  subject: string;
  text: string;
  html: string;
} {
  const tz = safeTz(o.tz);
  const period = `${fmtDay(o.from, tz)} to ${fmtDay(o.to - 1, tz)}`;
  const names = o.children.map((c) => c.nickname);
  const subject = names.length ? `Acorn week: ${names.join(", ")} (${period})` : `Your Acorn week (${period})`;
  const text: string[] = [`Your Acorn week, ${period}.`, ""];
  const html: string[] = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;color:#1f2a1f;line-height:1.45">`,
    `<h1 style="font-size:20px;margin:0 0 4px">🌰 Your Acorn week</h1><p style="color:#5b6b5b;margin:0 0 16px">${esc(period)}</p>`,
  ];
  if (o.warnIdle) {
    const w = "Nobody in your family has played for a long time, so your family's records will be deleted in 30 days. Play once, or sign in to the parent app, to keep them.";
    text.push(w, "");
    html.push(`<p style="background:#fff4d6;padding:10px;border-radius:8px">${esc(w)}</p>`);
  }
  for (const c of o.children) {
    text.push(`== ${c.nickname} ==`);
    html.push(`<h2 style="font-size:18px;margin:20px 0 6px;border-bottom:1px solid #dde5d5">${esc(c.nickname)}</h2>`);
    const played = c.games.filter((g) => g.answers || g.minutes);
    if (!played.length) {
      text.push("No play this week.", "");
      html.push(`<p style="color:#5b6b5b">No play this week.</p>`);
      continue;
    }
    for (const g of played) {
      const head = `${g.title}: ${minutesText(g.minutes)} over ${g.days_played} day${g.days_played === 1 ? "" : "s"}, ` +
        `${g.answers} questions, ${g.right_pct}% right first time.`;
      text.push(head);
      html.push(`<h3 style="font-size:15px;margin:12px 0 4px">${esc(g.title)}</h3><p style="margin:0 0 6px">` +
        `<b>${esc(minutesText(g.minutes))}</b> over ${g.days_played} day${g.days_played === 1 ? "" : "s"} · <b>${g.answers}</b> questions · ` +
        `<b>${g.right_pct}%</b> right first time</p>`);
      if (g.cleared.length) {
        const list = g.cleared.map((l) => `${l.label}${l.num ? ` ${l.num}` : ""}`).join(", ");
        text.push(`Levels finished: ${list}`);
        html.push(`<p style="margin:0 0 6px">Levels finished: ${esc(list)}</p>`);
      }
      if (g.progress?.worlds_complete.length) {
        text.push(`Worlds complete: ${g.progress.worlds_complete.join(", ")}`);
        html.push(`<p style="margin:0 0 6px">Worlds complete: ${esc(g.progress.worlds_complete.join(", "))}</p>`);
      }
      const top = g.by_skill.slice(0, 4);
      if (top.length) {
        text.push("Skills: " + top.map((s) => `${s.label} ${s.right_pct}% (${s.tries})`).join("; "));
        html.push(`<table style="border-collapse:collapse;font-size:14px;margin:4px 0 8px">` +
          top.map((s) => `<tr><td style="padding:2px 10px 2px 0">${esc(s.label)}</td><td style="padding:2px 10px 2px 0">${s.right_pct}% right</td><td style="color:#5b6b5b">${s.tries} tries, ${s.avg_secs} s each</td></tr>`).join("") +
          `</table>`);
      }
      if (g.practice.length) {
        const p = g.practice.slice(0, 5).map((x) => x.q.replace(/\s*=\s*\?$/, "")).join(", ");
        text.push(`Worth practising together: ${p}`);
        html.push(`<p style="margin:0 0 6px">Worth practising together: <b>${esc(p)}</b></p>`);
      }
      text.push("");
    }
  }
  if (o.appUrl) {
    text.push(`See more, print a record or change settings: ${o.appUrl}`);
    html.push(`<p style="margin-top:20px"><a href="${esc(o.appUrl)}">Open Acorn Grown-ups</a> to see more, print a record or change settings.</p>`);
  }
  const off = "You get this because weekly emails are on for you in Acorn Grown-ups. You can turn them off there.";
  text.push("", off);
  html.push(`<p style="color:#5b6b5b;font-size:12px;margin-top:20px">${esc(off)}</p></div>`);
  return { subject, text: text.join("\n"), html: html.join("\n") };
}

// re-exported for the parent app's print page tests
export { fmtDay, fmtTime, minutesText };
