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
const WORLDS = { lava_caves: "Lava Caves", crystal_mines: "Crystal Mines", bog: "the Bog", mushroom_forest: "Mushroom Forest", space: "Space" };
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
            <button data-act="records">Play records</button>
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
      if (act === "records") {
        state.view = "records";
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

// ------------------------------------------------------------ play records

/** Splits lines into play sessions: a gap of more than 10 minutes starts a new one. */
export function sessions(lines) {
  const sorted = [...lines].filter((l) => typeof l.t === "number").sort((a, b) => a.t - b.t || (a.seq ?? 0) - (b.seq ?? 0));
  const out = [];
  for (const l of sorted) {
    const cur = out[out.length - 1];
    if (!cur || l.t - cur.end > 600 || l.dev !== cur.dev) out.push({ start: l.t, end: l.t, dev: l.dev, lines: [l] });
    else {
      cur.end = l.t;
      cur.lines.push(l);
    }
  }
  return out.reverse();
}

export function summarize(lines) {
  const answers = lines.filter((l) => l.kind === "answer");
  const right = answers.filter((l) => l.right).length;
  const bySkill = {};
  const byWhere = {};
  for (const a of answers) {
    const s = (bySkill[a.skill ?? "unknown"] ??= { n: 0, right: 0, secs: 0 });
    s.n++;
    s.right += a.right ? 1 : 0;
    s.secs += Number(a.secs) || 0;
    const w = (byWhere[a.where ?? "other"] ??= { n: 0, right: 0 });
    w.n++;
    w.right += a.right ? 1 : 0;
  }
  const ses = sessions(lines);
  const minutes = ses.reduce((m, s) => m + Math.max(1, Math.round((s.end - s.start) / 60)), 0);
  const days = new Set(lines.filter((l) => l.t).map((l) => new Date(l.t * 1000).toDateString())).size;
  const ev = (name) => lines.filter((l) => l.kind === "event" && l.event === name).length;
  return {
    answers: answers.length, right, minutes, days, sessions: ses, bySkill, byWhere,
    cleared: ev("level_cleared"), fights: ev("fight_won"), bosses: ev("boss_won"), restarts: ev("restart"),
  };
}

async function recordsView(msg) {
  const c = state.family.children.find((x) => x.child === state.child);
  if (!c) {
    state.view = "home";
    return render();
  }
  app.innerHTML = `
    <p><button class="ghost" id="back">← Back</button></p>
    <div class="card">
      <div class="row"><div class="pic">${pic(c.picture)}</div><h2 class="grow" style="margin:0">${esc(c.nickname)}'s play records</h2></div>
      <div class="tabs" style="margin-top:10px">
        ${[7, 30, 90, 365].map((d) => `<button class="${d === state.days ? "" : "ghost"}" data-days="${d}">${d === 365 ? "Year" : `${d} days`}</button>`).join("")}
      </div>
      <div id="rec"><p class="muted">Loading…</p></div>
    </div>${msg}`;
  document.getElementById("back").onclick = () => {
    state.view = "home";
    state.msg = null;
    render();
  };
  app.querySelectorAll("[data-days]").forEach((b) => (b.onclick = () => {
    state.days = Number(b.dataset.days);
    render();
  }));
  const box = document.getElementById("rec");
  let data;
  try {
    data = await api("GET", `/children/${c.child}/games/${CONFIG.game}/records?days=${state.days}&limit=5000`);
  } catch (e) {
    box.innerHTML = `<div class="msg err">${esc(e.message)}</div>`;
    return;
  }
  if (state.view !== "records" || state.child !== c.child) return;
  const lines = data.lines;
  if (!lines.length) {
    box.innerHTML = `<p class="muted">Nothing yet in this time. Records show up after ${esc(c.nickname)} plays on a tablet in your family, with their player picked on the tablet.</p>`;
    return;
  }
  const s = summarize(lines);
  const skillRows = Object.entries(s.bySkill).sort((a, b) => b[1].n - a[1].n).map(([id, v]) => `
    <tr><td>${esc(state.skills[id] ?? id)}</td><td>${v.n}</td>
    <td><div class="row"><div class="bar grow"><i style="width:${pct(v.right, v.n)}%"></i></div>${pct(v.right, v.n)}%</div></td>
    <td>${v.n ? (v.secs / v.n).toFixed(1) : "-"} s</td></tr>`).join("");
  const whereRows = Object.entries(s.byWhere).map(([k, v]) => `<tr><td>${esc(WHERE[k] ?? k)}</td><td>${v.n}</td><td>${pct(v.right, v.n)}%</td></tr>`).join("");
  const sesRows = s.sessions.slice(0, 20).map((x) => {
    const a = x.lines.filter((l) => l.kind === "answer");
    const worlds = [...new Set(x.lines.map((l) => WORLDS[l.world] ?? l.world).filter(Boolean))].join(", ");
    return `<tr><td>${day(x.start)} ${new Date(x.start * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</td>
      <td>${Math.max(1, Math.round((x.end - x.start) / 60))} min</td><td>${a.length}</td><td>${pct(a.filter((l) => l.right).length, a.length)}%</td><td>${esc(worlds)}</td></tr>`;
  }).join("");
  const recent = lines.filter((l) => l.kind === "answer").slice(0, 40).map((l) => `
    <tr><td>${new Date(l.t * 1000).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })}</td><td>${esc(WHERE[l.where] ?? l.where ?? "")}</td><td>${esc(l.q ?? "")}</td>
    <td>${esc(l.pick)}</td><td>${esc(l.answer)}</td><td>${l.right ? `<span class="ok">✓</span>` : `<span class="no">✗</span>`}</td><td>${esc(l.secs)} s</td></tr>`).join("");
  box.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${s.answers}</b>questions answered</div>
      <div class="stat"><b>${pct(s.right, s.answers)}%</b>right first time</div>
      <div class="stat"><b>${s.minutes} min</b>played over ${s.days} day${s.days === 1 ? "" : "s"}</div>
      <div class="stat"><b>${s.cleared}</b>levels cleared</div>
      <div class="stat"><b>${s.fights + s.bosses}</b>fights and bosses won</div>
    </div>
    ${data.truncated ? `<p class="muted small">Showing the newest ${lines.length} records only.</p>` : ""}
    <h2 style="margin-top:16px">By skill</h2>
    <div class="scroll"><table><tr><th>Skill</th><th>Tries</th><th>Right</th><th>Average time</th></tr>${skillRows}</table></div>
    <h2 style="margin-top:16px">Where</h2>
    <div class="scroll"><table><tr><th>Part of the game</th><th>Tries</th><th>Right</th></tr>${whereRows}</table></div>
    <h2 style="margin-top:16px">Play sessions</h2>
    <div class="scroll"><table><tr><th>When</th><th>Length</th><th>Questions</th><th>Right</th><th>Worlds</th></tr>${sesRows}</table></div>
    <h2 style="margin-top:16px">Latest answers</h2>
    <div class="scroll"><table><tr><th>When</th><th>Where</th><th>Question</th><th>Picked</th><th>Answer</th><th></th><th>Time</th></tr>${recent}</table></div>`;
}

start();
