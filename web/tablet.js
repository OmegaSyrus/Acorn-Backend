// A stand-in for the game's Family screen (sync add-on, thread 4, not built
// yet): asks for a pairing code, shows it with a QR, waits for a parent to
// approve it, links players to children and sends made-up play lines. It
// talks to the same /v1 calls the game will, with a device token kept in
// this browser only.
import { CONFIG } from "./config.js";

const app = document.getElementById("app");
const KEY = "acorn.testTablet";
const WORLDS = ["lava_caves", "crystal_mines", "bog", "mushroom_forest", "space"];

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function hex(n) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function loadState() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? null;
  } catch {
    return null;
  }
}
let st = loadState() ?? { dev: "d_" + hex(8), seq: 0, boot: 1 };
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
  } catch { /* fine */ }
}
save();
let pairing = null;
let note = "";

async function call(method, path, body, raw) {
  const headers = {};
  if (st.token) headers.authorization = `Device ${st.token}`;
  if (body) headers["content-type"] = "application/json";
  const r = await fetch(CONFIG.api + path, { method, headers, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await r.text();
  const out = text ? JSON.parse(text) : null;
  if (r.status === 410) {
    delete st.token;
    st.children = [];
    st.profiles = {};
    save();
    throw new Error("This tablet was removed from the family. It plays on unpaired.");
  }
  if (!r.ok) throw new Error(out?.detail || out?.error || `error ${r.status}`);
  return out;
}

function render() {
  const msg = note ? `<div class="msg">${esc(note)}</div>` : "";
  if (!st.token) {
    app.innerHTML = `
      <div class="card center">
        <h2>Add this tablet to a family</h2>
        <p class="muted small">Device id ${esc(st.dev)}</p>
        ${pairing ? `
          <p>On a grown-up's phone, sign in and type this code, or scan the QR.</p>
          <div class="code">${esc(pairing.code)}</div>
          <div class="qr" id="qr" style="margin:12px auto"></div>
          <p class="muted small" id="wait">Waiting for a grown-up… (runs out in 10 minutes)</p>
          <button class="ghost" id="cancel">Cancel</button>` : `<button id="start">Show a pairing code</button>`}
        ${msg}
      </div>`;
    if (pairing) {
      const link = pairing.qr_url ?? new URL(`./#pair/${pairing.code}`, location.href).href;
      if (window.qrcode) {
        const q = window.qrcode(0, "M");
        q.addData(link);
        q.make();
        document.getElementById("qr").innerHTML = q.createImgTag(5, 8);
      }
      document.getElementById("qr").insertAdjacentHTML("beforeend", `<p class="small"><a href="${esc(link)}" target="_blank">${esc(link)}</a></p>`);
      document.getElementById("cancel").onclick = () => {
        clearTimeout(pairing.timer);
        pairing = null;
        render();
      };
    } else {
      document.getElementById("start").onclick = startPair;
    }
    return;
  }
  const kids = st.children ?? [];
  app.innerHTML = `
    <div class="card">
      <h2>${esc(st.name)} is in a family</h2>
      <p class="muted small">Device ${esc(st.dev)} · ${st.seq} lines sent</p>
      <h2 style="margin-top:12px">Who is playing?</h2>
      <div class="list">${kids.length ? kids.map((c) => `
        <div class="item"><div class="grow"><b>${esc(c.nickname)}</b><br><span class="muted small">player ${esc(st.profiles?.[c.child] ?? "not linked")}</span></div>
          <button data-play="${esc(c.child)}">Play a short game as ${esc(c.nickname)}</button></div>`).join("")
        : `<p class="muted">The family has no children yet. Add one on the Grown-ups page, then press Refresh.</p>`}
      </div>
      <div class="row" style="margin-top:12px">
        <button class="ghost" id="refresh">Refresh children</button>
        <button class="danger" id="forget">Forget the pairing on this tablet</button>
      </div>
      ${msg}
    </div>`;
  app.querySelectorAll("[data-play]").forEach((b) => (b.onclick = () => play(b.dataset.play)));
  document.getElementById("refresh").onclick = refreshChildren;
  document.getElementById("forget").onclick = () => {
    st = { dev: st.dev, seq: st.seq, boot: st.boot };
    save();
    note = "Forgotten here. The family still lists this tablet until a grown-up removes it.";
    render();
  };
}

async function startPair() {
  note = "";
  try {
    pairing = await call("POST", "/devices/pair/start", { game: CONFIG.game, dev: st.dev, app: "web-test", code: 1 });
    render();
    poll();
  } catch (e) {
    note = e.message;
    render();
  }
}

async function poll() {
  if (!pairing) return;
  try {
    const r = await call("GET", `/devices/pair/poll?pair_id=${pairing.pair_id}`);
    if (r.state === "approved") {
      pairing = null;
      Object.assign(st, { token: r.device_token, family: r.family, name: r.name, children: r.children, profiles: {} });
      save();
      await linkProfiles();
      note = "Paired. Each child now has a player on this tablet.";
      return render();
    }
    if (r.state === "expired") {
      pairing = null;
      note = "The code ran out. Show a new one.";
      return render();
    }
  } catch (e) {
    note = e.message;
  }
  if (pairing) pairing.timer = setTimeout(poll, 3000);
}

async function linkProfiles() {
  st.profiles ??= {};
  for (const c of st.children ?? []) st.profiles[c.child] ??= "p_" + hex(6);
  save();
  await call("PUT", `/devices/${st.dev}/profiles`, {
    profiles: (st.children ?? []).map((c) => ({ profile: st.profiles[c.child], child: c.child, nickname: c.nickname, picture: c.picture ?? "", guest: false })),
  });
}

async function refreshChildren() {
  // the game learns new children by pairing again or from GET /family later;
  // here the snapshot list call is enough to prove the token still works
  note = "";
  try {
    await call("PUT", `/devices/${st.dev}/profiles`, { profiles: [] });
    note = "Still paired. New children appear here after pairing again (the real game will fetch them).";
  } catch (e) {
    note = e.message;
  }
  render();
}

function makeLines(profile) {
  const now = Math.floor(Date.now() / 1000);
  const world = WORLDS[Math.floor(Math.random() * WORLDS.length)];
  const base = (extra, i) => ({
    v: 2, game: CONFIG.game, dev: st.dev, profile, seq: ++st.seq, boot: st.boot, t: now - 300 + i * 12, mono_ms: i * 12000,
    app: "web-test", code: 1, cv: 1, world, area: `${world}_1`, level: 1, level_id: 1, ...extra,
  });
  const out = [base({ kind: "event", event: "run_start" }, 0)];
  const n = 12 + Math.floor(Math.random() * 10);
  for (let i = 1; i <= n; i++) {
    const sub = Math.random() < 0.3;
    let a = 1 + Math.floor(Math.random() * 6), b = 1 + Math.floor(Math.random() * 6);
    if (sub && b > a) [a, b] = [b, a];
    const answer = sub ? a - b : a + b;
    const right = Math.random() < 0.75;
    const pick = right ? answer : Math.max(0, answer + (Math.random() < 0.5 ? -1 : 1));
    const total = sub ? a : a + b;
    const size = total <= 6 ? "within6" : total <= 10 ? "within10" : "within20";
    const where = ["stone", "stone", "stone", "fight", "duel", "boss"][Math.floor(Math.random() * 6)];
    out.push(base({
      kind: "answer", where, skill: `${sub ? "sub" : "add"}.${size}`, q: `${a} ${sub ? "-" : "+"} ${b} = ?`, op: sub ? "sub" : "add",
      dice: [a, b], choices: [answer - 1, answer, answer + 1].filter((x) => x >= 0), answer, pick, right, secs: Math.round((1 + Math.random() * 6) * 10) / 10,
    }, i));
    if (!right) out.push(base({ kind: "event", event: "heart_lost", where }, i));
  }
  out.push(base({ kind: "event", event: "level_cleared" }, n + 1));
  if (Math.random() < 0.5) out.push(base({ kind: "event", event: "fight_won", where: "fight" }, n + 1));
  return out;
}

async function play(child) {
  note = "";
  try {
    if (!st.profiles?.[child]) await linkProfiles();
    const before = st.seq;
    const lines = makeLines(st.profiles[child]);
    const r = await call("PUT", `/events/${CONFIG.game}/${st.dev}/${before + 1}-${st.seq}`, null, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    st.boot++;
    save();
    note = `Sent ${r.lines} lines. Open the child's Play records on the Grown-ups page.`;
  } catch (e) {
    note = e.message;
  }
  render();
}

render();
