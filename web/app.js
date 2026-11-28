// The parent web app (parent app plan v2, thread 5): sign in, make the
// family, add children, approve a tablet's pairing code, rename or remove
// tablets, and read each child's play records. Parents never move a child
// through the game: there are no level or world controls here.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { CONFIG } from "./config.js";

const sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey, {
  auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true },
});

// Profile pictures come from the game (profile plan C2, 2026-11-21): the ids in
// its latest manifest's `pictures`, drawn from pictures/<game>/<id>.png, names
// from `picture_labels`. Until a manifest is published, pictures/<game>/pictures.json
// holds the same list. LEGACY keeps the first web app's emoji ids readable.
const LEGACY = {
  owl: "🦉", bear: "🐻", frog: "🐸", cat: "🐱", dog: "🐶", dragon: "🐉", unicorn: "🦄", bee: "🐝",
};
export const PICTURES = { ids: [], labels: {} };
const NAME_MAX = 12; // the game's limit; the server allows 24
const WHERE = { stone: "Stepping stones", fight: "Fights", duel: "Miniboss duels", boss: "Boss fights" };
const PENDING_PAIR = "acorn.pendingPair";

const app = document.getElementById("app");
const state = { session: null, family: null, skills: {}, view: "home", child: null, days: 30, msg: null };

// ------------------------------------------------------------ small tools

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function picName(id) {
  return PICTURES.labels[id] ?? id;
}
/** A child's picture: the game's art, an old emoji, or the id itself. Never blank. */
function pic(id) {
  if (PICTURES.ids.includes(id)) {
    // a manifest id with no PNG here yet falls back to showing the id
    return `<img src="pictures/${esc(CONFIG.game)}/${esc(id)}.png" alt="${esc(picName(id))}" title="${esc(picName(id))}" data-id="${esc(id)}"
      onerror="this.replaceWith(Object.assign(document.createElement('span'), {className: 'picid', textContent: this.dataset.id}))">`;
  }
  if (LEGACY[id]) return `<span title="${esc(id)}">${LEGACY[id]}</span>`;
  return `<span class="picid" title="Picture ${esc(id)}">${esc(id || "?")}</span>`;
}
/** Picture tiles to pick from. A child's unknown id stays as its own tile so saving keeps it. */
function picturePicker(name, sel) {
  const ids = [...PICTURES.ids];
  if (sel && !ids.includes(sel)) ids.push(sel);
  if (!sel) sel = ids[0];
  return `<fieldset class="picker"><legend class="small muted">Picture</legend>${ids.map((id) => `
    <label class="tile" title="${esc(picName(id))}"><input type="radio" name="${esc(name)}" value="${esc(id)}" ${id === sel ? "checked" : ""}>
      <span class="pic">${pic(id)}</span><span class="small">${esc(picName(id))}</span></label>`).join("")}</fieldset>`;
}
async function loadPictures() {
  let m = null;
  try {
    const r = await fetch(`${CONFIG.api}/games/${CONFIG.game}/manifests/latest`);
    if (r.ok) m = await r.json();
  } catch { /* offline: use the local list */ }
  if (!Array.isArray(m?.pictures) || !m.pictures.length) {
    try {
      const r = await fetch(`pictures/${CONFIG.game}/pictures.json`);
      if (r.ok) m = await r.json();
    } catch { /* keep empty */ }
  }
  PICTURES.ids = (m?.pictures ?? []).filter((id) => typeof id === "string");
  PICTURES.labels = m?.picture_labels && typeof m.picture_labels === "object" ? m.picture_labels : {};
}
function when(v) {
  if (!v) return "never";
  const d = typeof v === "number" ? new Date(v * 1000) : new Date(v);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function day(t) {
  return new Date(t * 1000).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function pct(a, b) {
  return b ? Math.round((100 * a) / b) : 0;
}
function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* private window: fine */ }
}
function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function flash(text, err = false) {
  state.msg = { text, err };
  render();
}

class ApiErr extends Error {
  constructor(status, body) {
    super(body?.detail || body?.error || `error ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function api(method, path, body) {
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  const r = await fetch(CONFIG.api + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const out = text ? JSON.parse(text) : null;
  if (!r.ok) throw new ApiErr(r.status, out);
  return out;
}

// ------------------------------------------------------------ routing

function readHash() {
  const m = location.hash.match(/^#pair\/([A-Za-z0-9 -]{4,12})$/);
  if (m) {
    store(PENDING_PAIR, m[1].toUpperCase());
    history.replaceState(null, "", location.pathname);
  }
}

async function start() {
  if (CONFIG.staging) {
    document.getElementById("banner").innerHTML = `<div class="banner">Test version on the staging server. Data here may be wiped.</div>`;
  }
  readHash();
  window.addEventListener("hashchange", () => {
    readHash();
    render();
  });
  document.getElementById("signout").onclick = async () => {
    await sb.auth.signOut();
    state.family = null;
    render();
  };
  fetch("../contract/skills.json").then((r) => r.ok ? r.json() : null).then((j) => {
    for (const s of j?.skills ?? []) state.skills[s.id] = s.label;
  }).catch(() => {});
  await loadPictures();
  sb.auth.onAuthStateChange((_e, session) => {
    const was = state.session?.user?.id;
    state.session = session;
    if (session?.user?.id !== was) refresh();
  });
  const { data } = await sb.auth.getSession();
  state.session = data.session;
  await refresh();
}

async function refresh() {
  if (!state.session) {
    state.family = null;
    return render();
  }
  try {
    state.family = await api("GET", "/family");
  } catch (e) {
    if (e.status === 409) state.family = "none";
    else if (e.status === 401) {
      await sb.auth.signOut();
      state.session = null;
    } else state.msg = { text: `Could not load your family: ${e.message}`, err: true };
  }
  render();
}

// ------------------------------------------------------------ views

function render() {
  const who = document.getElementById("who");
  who.textContent = state.session?.user?.email ?? "";
  document.getElementById("signout").hidden = !state.session;
  const msg = state.msg ? `<div class="msg ${state.msg.err ? "err" : ""}">${esc(state.msg.text)}</div>` : "";
  if (!state.session) return signInView(msg);
  if (state.family === null) return (app.innerHTML = `<p class="muted">Loading…</p>${msg}`);
  if (state.family === "none") return consentView(msg);
  if (state.view === "records" && state.child) return recordsView(msg);
  if (state.view === "print" && state.child) return printView(msg);
  if (state.view === "controls" && state.child) return controlsView(msg);
  return homeView(msg);
}

function signInView(msg) {
  const pending = load(PENDING_PAIR);
  app.innerHTML = `
    <div class="card">
      <h2>Sign in</h2>
      <p class="muted small">For parents and caregivers. Children never sign in: their tablet is added to your family with a code.</p>
      ${pending ? `<div class="msg">Sign in to add the tablet showing <b>${esc(pending)}</b>.</div>` : ""}
      <p><button id="google">Sign in with Google</button></p>
      <form id="emailForm" class="row">
        <input id="email" class="grow" type="email" required placeholder="you@example.com" autocomplete="email">
        <button>Email me a sign-in link</button>
      </form>
      <form id="codeForm" class="row" style="margin-top:10px" ${state.sentTo ? "" : "hidden"}>
        <input id="otp" class="grow" inputmode="numeric" placeholder="6-digit code from the email" autocomplete="one-time-code">
        <button>Sign in with the code</button>
      </form>
      ${msg}
    </div>`;
  document.getElementById("google").onclick = async () => {
    const { error } = await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });
    if (error) flash(error.message, true);
  };
  document.getElementById("emailForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const email = document.getElementById("email").value.trim();
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) return flash(error.message, true);
    state.sentTo = email;
    flash(`Sent. Open the link in the email on this device, or type the code from it below.`);
  };
  document.getElementById("codeForm").onsubmit = async (ev) => {
    ev.preventDefault();
    const token = document.getElementById("otp").value.replace(/\s/g, "");
    const { error } = await sb.auth.verifyOtp({ email: state.sentTo, token, type: "email" });
    if (error) return flash(error.message, true);
    state.msg = null;
  };
}

function consentView(msg) {
  app.innerHTML = `
    <div class="card">
      <h2>Make your family</h2>
      <p>Acorn Mathematics keeps your children's play records so you can see how they are doing. Here is what we keep:</p>
      <ul>
        <li>Each child's nickname, a picture, and a birth year if you add one. No real names are needed.</li>
        <li>What they answered in the game, how long they took, and where they played.</li>
        <li>Which tablets you added and what they are called.</li>
      </ul>
      <p>Records are deleted 24 months after a child last plays. You can download everything or delete it all at any time from this page.</p>
      <label class="row"><input type="checkbox" id="agree"> <span>I am this child's parent or guardian and I agree.</span></label>
      <p><button id="make" disabled>Make my family</button></p>
      ${msg}
    </div>`;
  const agree = document.getElementById("agree");
  const make = document.getElementById("make");
  agree.onchange = () => (make.disabled = !agree.checked);
  make.onclick = async () => {
    make.disabled = true;
    try {
      state.family = await api("POST", "/family", { consent_version: CONFIG.consentVersion, consent_method: "web_checkbox" });
      state.msg = null;
      render();
    } catch (e) {
      flash(e.message, true);
    }
  };
}

function homeView(msg) {
  const f = state.family;
  const canEdit = f.role === "owner" || f.role === "caregiver";
  const pending = load(PENDING_PAIR) ?? "";
  const childName = Object.fromEntries(f.children.map((c) => [c.child, c.nickname]));
  app.innerHTML = `
    ${msg}
    <div class="card">
      <h2>Children</h2>
      <div class="list">
        ${f.children.length ? f.children.map((c) => `
          <div class="item" data-child="${esc(c.child)}">
            <div class="pic">${pic(c.picture)}</div>
            <div class="grow">
              <b>${esc(c.nickname)}</b>${c.birth_year ? ` <span class="muted small">born ${esc(c.birth_year)}</span>` : ""}<br>
              <span class="muted small">Last played: ${when(c.last_play_at)}</span>
            </div>
            <button data-act="records">Report</button>
            <button class="ghost" data-act="print">Print record</button>
            <button class="ghost" data-act="controls">Controls</button>
            ${canEdit ? `<button class="ghost" data-act="edit">Edit</button>` : ""}
            ${f.role === "owner" ? `<button class="danger" data-act="delete">Remove</button>` : ""}
          </div>`).join("") : `<p class="muted">No children yet. Add one below, then add their tablet.</p>`}
      </div>
      ${canEdit ? `
      <form id="addChild" style="margin-top:12px">
        <div class="row">
          <input id="nick" class="grow" required maxlength="${NAME_MAX}" placeholder="Nickname (up to ${NAME_MAX} letters)">
          <input id="year" type="number" min="2000" max="2100" placeholder="Birth year (optional)" style="width:190px">
        </div>
        ${picturePicker("picture", "")}
        <button>Add child</button>
      </form>` : ""}
    </div>

    <div class="card">
      <h2>Tablets</h2>
      <div class="list">
        ${f.devices.length ? f.devices.map((d) => `
          <div class="item" data-dev="${esc(d.dev)}">
            <div class="pic">📱</div>
            <div class="grow">
              <b>${esc(d.name)}</b> <span class="muted small">${esc(d.game)}${d.app ? ` ${esc(d.app)}` : ""}</span><br>
              <span class="muted small">Added ${when(d.paired_at)} · last seen ${when(d.last_seen_at)}</span><br>
              <span class="small">${(d.profiles ?? []).filter((p) => !p.guest).map((p) => `${esc(p.nickname || "profile")} → ${esc(childName[p.child] ?? "not linked")}`).join(" · ") || `<span class="muted">No players linked yet: pick who is who on the tablet.</span>`}</span>
            </div>
            ${canEdit ? `<button class="ghost" data-act="rename">Rename</button><button class="danger" data-act="remove">Remove</button>` : ""}
          </div>`).join("") : `<p class="muted">No tablets yet.</p>`}
      </div>
      ${canEdit ? `
      <h2 style="margin-top:14px">Add a tablet</h2>
      <p class="muted small">On the tablet, open Grown-ups, then Family, to see a code. Type it here, or scan the tablet's QR code with this phone.</p>
      <form id="pair" class="row">
        <input id="code" required placeholder="Code, like K7Q-42M" value="${esc(pending)}" style="width:190px;text-transform:uppercase">
        <input id="devname" class="grow" maxlength="40" placeholder="Name, like Kitchen tablet">
        <button>Add tablet</button>
      </form>` : ""}
    </div>

    <div class="card">
      <h2>Weekly email</h2>
      <div id="weekly"><p class="muted">Loading…</p></div>
    </div>

    <div class="card">
      <h2>Your data</h2>
      <p class="muted small">You are the family's ${esc(f.role)}. Records are kept 24 months after a child last plays.</p>
      <div class="row">
        <button class="ghost" id="export">Download everything (JSON)</button>
        ${f.role === "owner" ? `<button class="danger" id="wipe">Delete the whole family</button>` : ""}
      </div>
    </div>`;

  app.querySelectorAll("[data-child]").forEach((el) => {
    const id = el.dataset.child;
    const c = f.children.find((x) => x.child === id);
    el.querySelectorAll("button").forEach((b) => (b.onclick = async () => {
      const act = b.dataset.act;
      if (act === "records" || act === "print" || act === "controls") {
        state.view = act;
        state.child = id;
        state.msg = null;
        return render();
      }
      if (act === "edit") return editChild(el, c);
      if (act === "delete") {
        if (!confirm(`Remove ${c.nickname} and all their play records? This cannot be undone.`)) return;
        try {
          await api("DELETE", `/children/${id}`);
          state.msg = { text: `${c.nickname} was removed.` };
          await refresh();
        } catch (e) {
          flash(e.message, true);
        }
      }
    }));
  });
  app.querySelectorAll("[data-dev]").forEach((el) => {
    const id = el.dataset.dev;
    const d = f.devices.find((x) => x.dev === id);
    el.querySelectorAll("button").forEach((b) => (b.onclick = async () => {
      try {
        if (b.dataset.act === "rename") {
          const name = prompt("New name for this tablet", d.name);
          if (!name?.trim()) return;
          await api("PATCH", `/devices/${id}`, { name: name.trim() });
        } else {
          if (!confirm(`Remove ${d.name}? It keeps working as a game but stops sending records.`)) return;
          await api("DELETE", `/devices/${id}`);
        }
        state.msg = null;
        await refresh();
      } catch (e) {
        flash(e.message, true);
      }
    }));
  });
  const add = document.getElementById("addChild");
  if (add) add.onsubmit = async (ev) => {
    ev.preventDefault();
    const year = document.getElementById("year").value;
    try {
      await api("POST", "/family/children", {
        nickname: document.getElementById("nick").value.trim(),
        picture: add.querySelector("input[name=picture]:checked")?.value ?? PICTURES.ids[0] ?? "fox",
        ...(year ? { birth_year: Number(year) } : {}),
      });
      state.msg = null;
      await refresh();
    } catch (e) {
      flash(e.message, true);
    }
  };
  const pair = document.getElementById("pair");
  if (pair) pair.onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const r = await api("POST", "/devices/pair/approve", {
        code: document.getElementById("code").value,
        device_name: document.getElementById("devname").value.trim() || "Tablet",
      });
      store(PENDING_PAIR, null);
      state.msg = { text: `${r.name} is now in your family. On the tablet, pick which player is which child.` };
      await refresh();
    } catch (e) {
      flash(e.status === 404 ? "That code was not found or ran out. Show a new code on the tablet and try again." : e.message, true);
    }
  };
  document.getElementById("export").onclick = async () => {
    try {
      const data = await api("GET", "/family/export");
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: `acorn-family-${new Date().toISOString().slice(0, 10)}.json` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      flash(e.message, true);
    }
  };
  const wipe = document.getElementById("wipe");
  if (wipe) wipe.onclick = async () => {
    const typed = prompt("This deletes every child, tablet and record. Type DELETE to confirm.");
    if (typed !== "DELETE") return;
    try {
      await api("DELETE", "/family");
      state.family = "none";
      state.msg = { text: "Your family and all its records were deleted." };
      render();
    } catch (e) {
      flash(e.message, true);
    }
  };
  emailCard();
}

function editChild(el, c) {
  el.innerHTML = `
    <form class="grow">
      <div class="row">
        <input name="nick" class="grow" required maxlength="${NAME_MAX}" value="${esc(c.nickname)}">
        <input name="year" type="number" min="2000" max="2100" placeholder="Birth year" value="${esc(c.birth_year ?? "")}" style="width:140px">
      </div>
      ${picturePicker("picture", c.picture)}
      <div class="row"><button>Save</button><button type="button" class="ghost" data-cancel>Cancel</button></div>
    </form>`;
  const form = el.querySelector("form");
  form.querySelector("[data-cancel]").onclick = () => render();
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      await api("PATCH", `/children/${c.child}`, {
        nickname: form.nick.value.trim(),
        picture: form.querySelector("input[name=picture]:checked")?.value ?? c.picture,
        birth_year: form.year.value ? Number(form.year.value) : null,
      });
      state.msg = null;
      await refresh();
    } catch (e) {
      flash(e.message, true);
    }
  };
}

// ------------------------------------------------------------ reports
// The numbers come from GET /v1/children/{child}/report (one section per
// game), the same report the weekly email and the printed record use.

const RANGES = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [365, "Year"]];

function mins(m) {
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
function clock(t) {
  return new Date(t * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function bar(p) {
  return `<div class="row"><div class="bar grow"><i style="width:${p}%"></i></div>${p}%</div>`;
}
function plural(n, one, many = one + "s") {
  return `${n} ${n === 1 ? one : many}`;
}

function childNav(c, active) {
  const tabs = [["records", "Report"], ["print", "Printable record"], ["controls", "Controls"]];
  return `
    <p><button class="ghost noprint" id="back">← Back</button></p>
    <div class="row noprint" style="margin-bottom:10px"><div class="pic">${pic(c.picture)}</div><h2 class="grow" style="margin:0">${esc(c.nickname)}</h2></div>
    <div class="tabs noprint">${tabs.map(([v, l]) => `<button class="${v === active ? "" : "ghost"}" data-view="${v}">${l}</button>`).join("")}</div>`;
}
function wireNav() {
  document.getElementById("back").onclick = () => {
    state.view = "home";
    state.msg = null;
    render();
  };
  app.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => {
    state.view = b.dataset.view;
    state.msg = null;
    render();
  }));
}
function currentChild() {
  const c = state.family.children.find((x) => x.child === state.child);
  if (!c) {
    state.view = "home";
    render();
  }
  return c;
}

/** One game's numbers: tiles, progress, skills, sums to practise. Shared by the report and the print page. */
function gameSection(g, { print = false } = {}) {
  const p = g.progress;
  const worlds = p?.worlds?.length ? `
    <h3>Worlds</h3>
    <div class="scroll"><table><tr><th>World</th><th>Levels done</th><th>Stars</th><th></th></tr>
    ${p.worlds.map((w) => `<tr><td>${esc(w.label)}</td><td>${w.done} of ${w.total}</td><td>${w.stars}</td><td>${w.complete ? `<span class="ok">Complete</span>` : ""}</td></tr>`).join("")}
    </table></div>` : `<p class="muted small">World progress shows once the tablet has backed up this child's save.</p>`;
  const skills = g.by_skill.length ? `
    <h3>Skills practised</h3>
    <div class="scroll"><table><tr><th>Skill</th><th>Tries</th><th>Right first time</th><th>Average time</th></tr>
    ${g.by_skill.map((s) => `<tr><td>${esc(s.label)}</td><td>${s.tries}</td><td>${print ? `${s.right_pct}%` : bar(s.right_pct)}</td><td>${s.avg_secs} s</td></tr>`).join("")}
    </table></div>` : "";
  const practice = g.practice.length ? `
    <h3>Sums to practise</h3>
    <p class="muted small">Missed at least once, or right but slow (${g.slow_secs} s or more).</p>
    <div class="scroll"><table><tr><th>Sum</th><th>Tries</th><th>Missed</th><th>Slow</th><th>Average time</th></tr>
    ${g.practice.map((x) => `<tr><td><b>${esc(x.q)}</b></td><td>${x.tries}</td><td>${x.missed}</td><td>${x.slow}</td><td>${x.avg_secs} s</td></tr>`).join("")}
    </table></div>` : "";
  const counts = new Map();
  for (const l of g.cleared) {
    const k = `${l.label}${l.num ? ` ${l.num}` : ""}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const cleared = counts.size ? `<p><b>Levels finished:</b> ${esc([...counts].map(([k, n]) => (n > 1 ? `${k} (${n} times)` : k)).join(", "))}</p>` : "";
  return `
    <div class="stats">
      <div class="stat"><b>${mins(g.minutes)}</b>played over ${plural(g.days_played, "day")}</div>
      <div class="stat"><b>${g.answers}</b>questions answered</div>
      <div class="stat"><b>${g.right_pct}%</b>right first time</div>
      <div class="stat"><b>${g.levels_cleared}</b>levels finished</div>
      <div class="stat"><b>${g.fights_won + g.bosses_won}</b>fights and bosses won</div>
      ${p?.level_setting ? `<div class="stat"><b>Level ${p.level_setting}</b>the game's Level now</div>` : ""}
    </div>
    ${p?.worlds_complete?.length ? `<p><b>Worlds complete:</b> ${esc(p.worlds_complete.join(", "))}</p>` : ""}
    ${cleared}${worlds}${skills}${practice}`;
}

async function recordsView(msg) {
  const c = currentChild();
  if (!c) return;
  app.innerHTML = `${childNav(c, "records")}
    <div class="card">
      <div class="tabs">${RANGES.map(([d, l]) => `<button class="${d === state.days ? "" : "ghost"}" data-days="${d}">${l}</button>`).join("")}</div>
      <div id="rec"><p class="muted">Loading…</p></div>
    </div>${msg}`;
  wireNav();
  app.querySelectorAll("[data-days]").forEach((b) => (b.onclick = () => {
    state.days = Number(b.dataset.days);
    render();
  }));
  const box = document.getElementById("rec");
  let rep, rec;
  try {
    rep = await api("GET", `/children/${c.child}/report?days=${state.days}`);
    rec = await api("GET", `/children/${c.child}/games/${CONFIG.game}/records?days=${state.days}&limit=200`).catch(() => ({ lines: [] }));
  } catch (e) {
    box.innerHTML = `<div class="msg err">${esc(e.message)}</div>`;
    return;
  }
  if (state.view !== "records" || state.child !== c.child) return;
  const played = rep.games.filter((g) => g.answers || g.minutes || g.progress);
  if (!played.length) {
    box.innerHTML = `<p class="muted">Nothing yet in this time. Records show up after ${esc(c.nickname)} plays on a tablet in your family, with their player picked on the tablet.</p>`;
    return;
  }
  const recent = rec.lines.filter((l) => l.kind === "answer").slice(0, 30).map((l) => `
    <tr><td>${new Date(l.t * 1000).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })}</td><td>${esc(WHERE[l.where] ?? l.where ?? "")}</td><td>${esc(l.q ?? "")}</td>
    <td>${esc(l.pick)}</td><td>${esc(l.answer)}</td><td>${l.right ? `<span class="ok">✓</span>` : `<span class="no">✗</span>`}</td><td>${esc(l.secs)} s</td></tr>`).join("");
  box.innerHTML = played.map((g) => `
    <section class="game">
      ${rep.games.length > 1 ? `<h2>${esc(g.title)}</h2>` : ""}
      ${gameSection(g)}
      <h3>Play sessions</h3>
      <div class="scroll"><table><tr><th>When</th><th>Length</th><th>Questions</th><th>Right</th><th>Worlds</th></tr>
      ${g.sessions.slice(0, 20).map((x) => `<tr><td>${day(x.start)} ${clock(x.start)}</td><td>${x.minutes} min</td><td>${x.answers}</td><td>${pct(x.right, x.answers)}%</td><td>${esc(x.worlds.join(", "))}</td></tr>`).join("")}
      </table></div>
      ${g.truncated ? `<p class="muted small">This was a lot of play: only the newest records are counted.</p>` : ""}
    </section>`).join("<hr>") + (recent ? `
    <h3>Latest answers</h3>
    <div class="scroll"><table><tr><th>When</th><th>Where</th><th>Question</th><th>Picked</th><th>Answer</th><th></th><th>Time</th></tr>${recent}</table></div>` : "");
}

// ------------------------------------------------------------ printable record

function dateInput(t) {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** Local midnight of a yyyy-mm-dd, in unix seconds. */
function fromInput(v) {
  const [y, m, d] = v.split("-").map(Number);
  return Math.floor(new Date(y, m - 1, d).getTime() / 1000);
}

async function printView(msg) {
  const c = currentChild();
  if (!c) return;
  const today = Math.floor(Date.now() / 1000);
  state.printFrom ??= dateInput(today - 29 * 86400);
  state.printTo ??= dateInput(today);
  app.innerHTML = `${childNav(c, "print")}
    <div class="card noprint">
      <p class="muted small">A record of ${esc(c.nickname)}'s maths play for a homeschool file: dates, time spent, skills practised and levels finished. Pick the dates, then print or save as PDF.</p>
      <form id="range" class="row">
        <label class="small">From <input type="date" id="pf" value="${esc(state.printFrom)}" required></label>
        <label class="small">To <input type="date" id="pt" value="${esc(state.printTo)}" required></label>
        <button class="ghost">Show</button>
        <button type="button" id="doprint">Print or save as PDF</button>
      </form>
    </div>
    ${msg}
    <div class="card printable" id="sheet"><p class="muted">Loading…</p></div>`;
  wireNav();
  document.getElementById("range").onsubmit = (ev) => {
    ev.preventDefault();
    state.printFrom = document.getElementById("pf").value;
    state.printTo = document.getElementById("pt").value;
    render();
  };
  document.getElementById("doprint").onclick = () => window.print();
  const from = fromInput(state.printFrom);
  const to = fromInput(state.printTo) + 86400;
  const sheet = document.getElementById("sheet");
  if (!(to > from)) {
    sheet.innerHTML = `<div class="msg err">The end date must be on or after the start date.</div>`;
    return;
  }
  let rep;
  try {
    rep = await api("GET", `/children/${c.child}/report?from=${from}&to=${to}`);
  } catch (e) {
    sheet.innerHTML = `<div class="msg err">${esc(e.message)}</div>`;
    return;
  }
  if (state.view !== "print" || state.child !== c.child) return;
  const long = (t) => new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  const total = rep.games.reduce((m, g) => m + g.minutes, 0);
  const daysPlayed = new Set(rep.games.flatMap((g) => g.sessions.map((s) => new Date(s.start * 1000).toDateString()))).size;
  sheet.innerHTML = `
    <div class="sheet-head">
      <div>
        <h2 style="margin:0">Maths learning record</h2>
        <p style="margin:4px 0 0"><b>${esc(c.nickname)}</b>${c.birth_year ? ` · born ${esc(c.birth_year)}` : ""}</p>
        <p class="muted small" style="margin:0">${esc(long(from))} to ${esc(long(to - 86400))}</p>
      </div>
      <div class="small muted" style="text-align:right">Acorn Mathematics<br>Printed ${esc(long(today))}</div>
    </div>
    <p><b>${mins(total)}</b> of play on <b>${plural(daysPlayed, "day")}</b> in this period.</p>
    ${rep.games.map((g) => `
      <section class="game">
        <h2>${esc(g.title)}</h2>
        ${g.answers || g.minutes ? gameSection(g, { print: true }) : `<p class="muted">No play in this period.</p>`}
        ${g.sessions.length ? `
        <h3>Sessions</h3>
        <table><tr><th>Date</th><th>Start</th><th>Minutes</th><th>Questions</th><th>Right</th><th>Worlds</th></tr>
        ${[...g.sessions].reverse().map((x) => `<tr><td>${day(x.start)}</td><td>${clock(x.start)}</td><td>${x.minutes}</td><td>${x.answers}</td><td>${pct(x.right, x.answers)}%</td><td>${esc(x.worlds.join(", "))}</td></tr>`).join("")}
        </table>` : ""}
      </section>`).join("") || `<p class="muted">No games played yet.</p>`}
    <div class="sign">
      <div>Notes<div class="line"></div><div class="line"></div></div>
      <div class="row" style="gap:24px"><div class="grow">Parent or teacher<div class="line"></div></div><div style="width:30%">Date<div class="line"></div></div></div>
    </div>`;
}

// ------------------------------------------------------------ controls
// Only what the game's manifest offers (time limits and the like). Parents
// never move a child through the game: no Level or world switch is ever here.

async function controlsView(msg) {
  const c = currentChild();
  if (!c) return;
  const f = state.family;
  const canEdit = f.role === "owner" || f.role === "caregiver";
  app.innerHTML = `${childNav(c, "controls")}<div id="ctl"><p class="muted">Loading…</p></div>${msg}`;
  wireNav();
  const games = [...new Set([CONFIG.game, ...f.devices.map((d) => d.game)])];
  const parts = [];
  for (const game of games) {
    let m = null, doc = null;
    try {
      const r = await fetch(`${CONFIG.api}/games/${encodeURIComponent(game)}/manifests/latest`);
      if (r.ok) m = await r.json();
      doc = await api("GET", `/children/${c.child}/games/${encodeURIComponent(game)}/settings`);
    } catch (e) {
      parts.push(`<div class="card"><h2>${esc(m?.title ?? game)}</h2><div class="msg err">${esc(e.message)}</div></div>`);
      continue;
    }
    const specs = (m?.settings ?? []).filter((s) => s.scope !== "device");
    const devCodes = f.devices.filter((d) => d.game === game && d.code).map((d) => d.code);
    const oldest = devCodes.length ? Math.min(...devCodes) : null;
    const field = (s) => {
      const cur = doc.fields[s.key]?.value ?? s.default;
      const id = `set_${game}_${s.key}`;
      const dis = !canEdit ? "disabled" : "";
      let input;
      if (s.type === "bool") input = `<input type="checkbox" id="${esc(id)}" ${cur ? "checked" : ""} ${dis}>`;
      else if (s.type === "int") input = `<input type="number" id="${esc(id)}" value="${esc(cur)}" min="${esc(s.min ?? "")}" max="${esc(s.max ?? "")}" style="width:110px" ${dis}>`;
      else if (s.type === "time") input = `<input type="time" id="${esc(id)}" value="${esc(cur ?? "")}" ${dis}> <span class="muted small">empty = none</span>`;
      else input = `<select id="${esc(id)}" ${dis}>${(s.options ?? []).map((o) => `<option ${o === cur ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
      const old = oldest !== null && s.since_code > oldest ? `<br><span class="muted small">A tablet has an older version of the game: update it to use this.</span>` : "";
      return `<div class="item"><div class="grow"><label for="${esc(id)}"><b>${esc(s.label)}</b></label>${s.help ? `<br><span class="muted small">${esc(s.help)}</span>` : ""}${old}</div>${input}</div>`;
    };
    parts.push(`<div class="card" data-game="${esc(game)}">
      <h2>${esc(m?.title ?? game)}</h2>
      ${specs.length ? `<form class="list">${specs.map(field).join("")}
        ${canEdit ? `<div class="item"><button>Save</button><span class="muted small" data-saved></span></div>` : ""}</form>`
        : `<p class="muted">This version of the game has no grown-up controls yet. Time limits arrive with the tablet update that links it to your family.</p>`}
      <p class="muted small">Levels and worlds are never changed from here: ${esc(c.nickname)} moves through the game by playing.</p>
    </div>`);
    state.specs = { ...(state.specs ?? {}), [game]: specs };
  }
  if (state.view !== "controls" || state.child !== c.child) return;
  document.getElementById("ctl").innerHTML = parts.join("");
  app.querySelectorAll("[data-game] form").forEach((form) => (form.onsubmit = async (ev) => {
    ev.preventDefault();
    const game = form.closest("[data-game]").dataset.game;
    const fields = {};
    for (const s of state.specs[game]) {
      const el = document.getElementById(`set_${game}_${s.key}`);
      fields[s.key] = { value: s.type === "bool" ? el.checked : s.type === "int" ? Number(el.value) : s.type === "time" ? (el.value || null) : el.value };
    }
    try {
      await api("PATCH", `/children/${c.child}/games/${encodeURIComponent(game)}/settings`, { fields });
      form.querySelector("[data-saved]").textContent = "Saved. The tablet picks it up next time it connects.";
    } catch (e) {
      flash(e.message, true);
    }
  }));
}

// ------------------------------------------------------------ weekly email

async function emailCard() {
  const box = document.getElementById("weekly");
  if (!box) return;
  let me;
  try {
    me = await api("GET", "/family/me");
  } catch (e) {
    if (box.isConnected) box.innerHTML = `<div class="msg err">${esc(e.message)}</div>`;
    return;
  }
  // the page was drawn again while this loaded: that drawing fills its own card
  if (!box.isConnected) return;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!me.tz && tz) api("PATCH", "/family/me", { tz }).catch(() => {});
  box.innerHTML = `
    <label class="row"><input type="checkbox" id="wk" ${me.weekly_email ? "checked" : ""}>
      <span>Email me a short report each week${me.email ? ` at <b>${esc(me.email)}</b>` : ""}</span></label>
    ${me.mail_on ? "" : `<p class="muted small">Sending is not switched on for this server yet. You can still see this week's email.</p>`}
    <div class="row" style="margin-top:8px">
      <button class="ghost" id="wkpv">See this week's email</button>
      ${me.mail_on ? `<button class="ghost" id="wktest">Send it to me now</button>` : ""}
    </div>
    <div id="wkout"></div>`;
  document.getElementById("wk").onchange = async (ev) => {
    try {
      await api("PATCH", "/family/me", { weekly_email: ev.target.checked });
    } catch (e) {
      flash(e.message, true);
    }
  };
  document.getElementById("wkpv").onclick = async () => {
    const out = document.getElementById("wkout");
    out.innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const m = await api("GET", "/family/weekly-email");
      out.innerHTML = `<p class="small"><b>Subject:</b> ${esc(m.subject)}</p><iframe class="mail" sandbox title="This week's email"></iframe>`;
      out.querySelector("iframe").srcdoc = m.html;
    } catch (e) {
      out.innerHTML = `<div class="msg err">${esc(e.message)}</div>`;
    }
  };
  const t = document.getElementById("wktest");
  if (t) t.onclick = async () => {
    try {
      const r = await api("POST", "/family/weekly-email/test");
      document.getElementById("wkout").innerHTML = `<div class="msg">Sent to ${esc(r.to)}.</div>`;
    } catch (e) {
      document.getElementById("wkout").innerHTML = `<div class="msg err">${esc(e.message)}</div>`;
    }
  };
}

start();
