// The /v1 API (contract/api-v1.md): everything a game calls, plus the
// parent calls that need more than row-level security allows (pairing,
// export, delete). Games call only these paths, never Supabase directly.
import { ApiError, body, CORS, errorResponse, json, need } from "./http.ts";
import type { Deps, Sql } from "./deps.ts";
import { schemaErrors } from "./schema.ts";
import { SCHEMAS } from "./contract.ts";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const GAME = /^[a-z][a-z0-9-]{1,31}$/;
const DEV = /^d_[0-9a-f]{16}$/;
const PROFILE = /^p_[0-9a-f]{12}$/;
const CHILD = /^c_[0-9a-f]{12}$/;
const PICTURE = /^[a-z0-9_]{1,32}$/;
const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const PAIR_SECONDS = 600;
const MAX_CHILDREN = 12;
const MAX_EVENTS_GZIP = 256 * 1024;
const MAX_EVENTS_TEXT = 4 * 1024 * 1024;
const MAX_SNAPSHOT = 512 * 1024;
export const RETENTION_MONTHS = 24;
export const IDLE_DELETE_DAYS = 30;
export const CONSENT_VERSIONS = ["2026-11-v1"];

// ------------------------------------------------------------------ small tools

export function hex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

function pairCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(6));
  const s = Array.from(b, (x) => PAIR_ALPHABET[x % PAIR_ALPHABET.length]).join("");
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

export function normalizeCode(c: string): string {
  const s = c.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === 6 ? `${s.slice(0, 3)}-${s.slice(3)}` : s;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

async function gunzip(bytes: Uint8Array, limit: number): Promise<Uint8Array> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > limit) throw new ApiError("too_large", `more than ${limit} bytes once unpacked`);
      parts.push(value);
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("bad_request", "body is not valid gzip");
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function secs(d: Deps): number {
  return Math.floor(d.now() / 1000);
}

function nowTs(d: Deps): Date {
  return new Date(d.now());
}

function authHeader(req: Request, scheme: string): string | null {
  const h = req.headers.get("authorization") ?? "";
  const [s, ...rest] = h.split(" ");
  return s.toLowerCase() === scheme.toLowerCase() && rest.length ? rest.join(" ").trim() : null;
}

// ------------------------------------------------------------------ who is calling

interface Parent {
  userId: string;
  familyId: string | null;
  role: string | null;
}

interface Device {
  id: string;
  familyId: string;
  game: string;
}

async function parent(req: Request, d: Deps): Promise<Parent> {
  const token = authHeader(req, "Bearer");
  if (!token) throw new ApiError("unauthorized", "sign in first");
  const userId = await d.parentUser(token);
  if (!userId) throw new ApiError("unauthorized", "sign-in expired");
  const [a] = await d.sql`select family_id, role from adults where user_id = ${userId}`;
  return { userId, familyId: a?.family_id ?? null, role: a?.role ?? null };
}

async function familyParent(req: Request, d: Deps, roles = ["owner", "caregiver", "viewer"]): Promise<Parent & { familyId: string }> {
  const p = await parent(req, d);
  if (!p.familyId) throw new ApiError("conflict", "no family yet: POST /v1/family first", { reason: "no_family" });
  if (!roles.includes(p.role!)) throw new ApiError("forbidden", `needs ${roles.join(" or ")}`);
  return p as Parent & { familyId: string };
}

async function device(req: Request, d: Deps): Promise<Device> {
  const token = authHeader(req, "Device");
  if (!token) throw new ApiError("unauthorized", "pair this device first");
  const hash = await sha256(token);
  const [row] = await d.sql`select id, family_id, game, removed_at from devices where token_hash = ${hash}`;
  if (!row) throw new ApiError("unauthorized", "unknown device token");
  if (row.removed_at) throw new ApiError("gone", "this device was removed from the family");
  await d.sql`update devices set last_seen_at = ${nowTs(d)} where id = ${row.id}`;
  return { id: row.id, familyId: row.family_id, game: row.game };
}

/** A parent of the child's family, or a device of it. */
async function childAccess(req: Request, d: Deps, childId: string): Promise<{ by: string; familyId: string; device?: Device; parent?: Parent }> {
  need(CHILD.test(childId), "bad child id");
  const [c] = await d.sql`select family_id from children where id = ${childId}`;
  if (authHeader(req, "Device")) {
    const dev = await device(req, d);
    if (!c || c.family_id !== dev.familyId) throw new ApiError("not_found", "no such child in this family");
    return { by: `device:${dev.id}`, familyId: dev.familyId, device: dev };
  }
  const p = await familyParent(req, d);
  if (!c || c.family_id !== p.familyId) throw new ApiError("not_found", "no such child in this family");
  return { by: "parent", familyId: p.familyId, parent: p };
}

// ------------------------------------------------------------------ family

async function createFamily(req: Request, d: Deps): Promise<Response> {
  const p = await parent(req, d);
  if (p.familyId) return json(await familyView(d, p.familyId, p.role!), 200);
  const b = await body(req);
  need(CONSENT_VERSIONS.includes(b.consent_version), `consent_version must be one of ${CONSENT_VERSIONS.join(", ")}`);
  const method = typeof b.consent_method === "string" ? b.consent_method.slice(0, 40) : "email_plus";
  const familyId = await d.sql.begin(async (tx) => {
    const [f] = await tx`insert into families default values returning id`;
    await tx`insert into adults (user_id, family_id, role) values (${p.userId}, ${f.id}, 'owner')`;
    await tx`insert into consents (family_id, user_id, version, method) values (${f.id}, ${p.userId}, ${b.consent_version}, ${method})`;
    return f.id as string;
  });
  return json(await familyView(d, familyId, "owner"), 201);
}

async function familyView(d: Deps, familyId: string, role: string): Promise<Row> {
  const [f] = await d.sql`select id, created_at, region from families where id = ${familyId}`;
  const adults = await d.sql`select user_id, role, created_at from adults where family_id = ${familyId} order by created_at`;
  const children = await d.sql`select id as child, nickname, birth_year, picture, created_at, last_play_at
    from children where family_id = ${familyId} order by created_at`;
  const devices = await d.sql`select id as dev, game, name, app, code, paired_at, last_seen_at
    from devices where family_id = ${familyId} and removed_at is null order by paired_at`;
  const profiles = await d.sql`select p.dev, p.profile, p.child_id as child, p.nickname, p.picture, p.guest
    from device_profiles p join devices v on v.id = p.dev where v.family_id = ${familyId} and v.removed_at is null`;
  for (const dv of devices) dv.profiles = profiles.filter((p: Row) => p.dev === dv.dev).map(({ dev: _d, ...r }: Row) => r);
  return { family: f.id, region: f.region, created_at: f.created_at, role, adults: [...adults], children: [...children], devices: [...devices] };
}

async function getFamily(req: Request, d: Deps): Promise<Response> {
  const p = await familyParent(req, d);
  return json(await familyView(d, p.familyId, p.role!));
}

function childFields(b: Row, partial: boolean): Row {
  const out: Row = {};
  if (!partial || "nickname" in b) {
    need(typeof b.nickname === "string" && b.nickname.trim().length >= 1 && b.nickname.trim().length <= 24, "nickname: 1 to 24 characters");
    out.nickname = b.nickname.trim();
  }
  if ("birth_year" in b) {
    need(b.birth_year === null || (Number.isInteger(b.birth_year) && b.birth_year >= 2000 && b.birth_year <= 2100), "birth_year: a year, or null");
    out.birth_year = b.birth_year;
  }
  if ("picture" in b) {
    need(typeof b.picture === "string" && PICTURE.test(b.picture), "picture: a picture id");
    out.picture = b.picture;
  }
  return out;
}

async function addChild(req: Request, d: Deps): Promise<Response> {
  const p = await familyParent(req, d, ["owner", "caregiver"]);
  const f = childFields(await body(req), false);
  const [{ n }] = await d.sql`select count(*)::int as n from children where family_id = ${p.familyId}`;
  if (n >= MAX_CHILDREN) throw new ApiError("conflict", `at most ${MAX_CHILDREN} children`);
  const [c] = await d.sql`insert into children (family_id, nickname, birth_year, picture)
    values (${p.familyId}, ${f.nickname}, ${f.birth_year ?? null}, ${f.picture ?? "fox"})
    returning id as child, nickname, birth_year, picture, created_at`;
  return json(c, 201);
}

async function patchChild(req: Request, d: Deps, childId: string): Promise<Response> {
  const p = await familyParent(req, d, ["owner", "caregiver"]);
  const f = childFields(await body(req), true);
  need(Object.keys(f).length > 0, "nothing to change");
  const [c] = await d.sql`update children set ${d.sql(f)} where id = ${childId} and family_id = ${p.familyId}
    returning id as child, nickname, birth_year, picture`;
  if (!c) throw new ApiError("not_found", "no such child in this family");
  return json(c);
}

/** Deletes a child: their rows, snapshots, and their lines in every event batch. */
async function deleteChild(req: Request, d: Deps, childId: string): Promise<Response> {
  const p = await familyParent(req, d, ["owner"]);
  const [c] = await d.sql`select id from children where id = ${childId} and family_id = ${p.familyId}`;
  if (!c) throw new ApiError("not_found", "no such child in this family");
  await purgeChild(d, childId);
  return json({ deleted: true });
}

async function purgeChild(d: Deps, childId: string): Promise<void> {
  const snaps = await d.sql`select path from snapshots where child_id = ${childId}`;
  const profiles = (await d.sql`select dev, profile from device_profiles where child_id = ${childId}`)
    .map((r: Row) => `${r.dev}/${r.profile}`);
  const batches = await d.sql`select u.game, u.dev, u.first_seq, u.last_seq, u.path,
      (select count(*) from upload_children o where (o.game, o.dev, o.first_seq, o.last_seq) = (u.game, u.dev, u.first_seq, u.last_seq)
        and o.child_id <> ${childId})::int as others
    from uploads u join upload_children k using (game, dev, first_seq, last_seq) where k.child_id = ${childId}`;
  const gone: string[] = snaps.map((s: Row) => s.path);
  for (const u of batches) {
    if (u.others === 0) {
      gone.push(u.path);
      await d.sql`delete from uploads where game = ${u.game} and dev = ${u.dev} and first_seq = ${u.first_seq} and last_seq = ${u.last_seq}`;
      continue;
    }
    // a batch shared with a brother or sister: keep their lines, drop this child's
    const raw = await d.blobs.get(u.path);
    if (raw) {
      const text = new TextDecoder().decode(await gunzip(raw, MAX_EVENTS_TEXT));
      const kept = text.split("\n").filter((l) => {
        if (!l.trim()) return false;
        try {
          const e = JSON.parse(l);
          return !profiles.includes(`${e.dev}/${e.profile}`);
        } catch {
          return true;
        }
      });
      await d.blobs.put(u.path, await gzip(new TextEncoder().encode(kept.join("\n") + "\n")), "application/gzip");
    }
  }
  if (gone.length) await d.blobs.remove(gone);
  await d.sql`delete from children where id = ${childId}`;
}

async function exportFamily(req: Request, d: Deps): Promise<Response> {
  const p = await familyParent(req, d);
  const view = await familyView(d, p.familyId, p.role!);
  const settings = await d.sql`select s.child_id as child, s.game, s.key, s.value, s.rev, s.at, s.by
    from settings s join children c on c.id = s.child_id where c.family_id = ${p.familyId}`;
  const consents = await d.sql`select version, method, at from consents where family_id = ${p.familyId}`;
  const snapRows = await d.sql`select s.path from snapshots s join children c on c.id = s.child_id where c.family_id = ${p.familyId}`;
  const snapshots = [];
  for (const s of snapRows) {
    const raw = await d.blobs.get(s.path);
    if (raw) snapshots.push(JSON.parse(new TextDecoder().decode(raw)));
  }
  const uploads = await d.sql`select game, dev, first_seq, last_seq, path from uploads where family_id = ${p.familyId} order by received_at`;
  const events = [];
  for (const u of uploads) {
    const raw = await d.blobs.get(u.path);
    if (!raw) continue;
    const lines = new TextDecoder().decode(await gunzip(raw, MAX_EVENTS_TEXT)).split("\n").filter((l) => l.trim());
    events.push({ game: u.game, dev: u.dev, first_seq: Number(u.first_seq), last_seq: Number(u.last_seq), lines: lines.map((l) => JSON.parse(l)) });
  }
  return json({ schema: "family.export", v: 1, exported_at: secs(d), ...view, settings: [...settings], consents: [...consents], snapshots, events });
}

async function deleteFamily(req: Request, d: Deps): Promise<Response> {
  const p = await familyParent(req, d, ["owner"]);
  await purgeFamily(d, p.familyId);
  return json({ deleted: true });
}

async function purgeFamily(d: Deps, familyId: string): Promise<void> {
  const paths = [
    ...(await d.sql`select path from uploads where family_id = ${familyId}`),
    ...(await d.sql`select s.path from snapshots s join children c on c.id = s.child_id where c.family_id = ${familyId}`),
  ].map((r: Row) => r.path);
  if (paths.length) await d.blobs.remove(paths);
  await d.sql`delete from families where id = ${familyId}`;
}

// ------------------------------------------------------------------ devices and pairing

async function pairStart(req: Request, d: Deps): Promise<Response> {
  const b = await body(req);
  need(typeof b.game === "string" && GAME.test(b.game), "game: a game id");
  need(typeof b.dev === "string" && DEV.test(b.dev), "dev: d_ + 16 hex");
  const now = nowTs(d);
  await d.sql`delete from pair_requests where expires_at < ${now} or (dev = ${b.dev} and approved_at is null)`;
  const id = "pr_" + hex(16);
  const expires = new Date(d.now() + PAIR_SECONDS * 1000);
  for (let tries = 0; ; tries++) {
    const code = pairCode();
    try {
      await d.sql`insert into pair_requests (id, code, game, dev, app, app_code, created_at, expires_at)
        values (${id}, ${code}, ${b.game}, ${b.dev}, ${typeof b.app === "string" ? b.app.slice(0, 20) : null},
                ${Number.isInteger(b.code) ? b.code : null}, ${now}, ${expires})`;
      const qr = d.pairUrlBase ? `${d.pairUrlBase}/${code}` : null;
      return json({ pair_id: id, code, qr_url: qr, expires_in: PAIR_SECONDS }, 201);
    } catch (e) {
      if (tries > 5 || !String(e).includes("pair_requests_code_key")) throw e;
    }
  }
}

async function pairApprove(req: Request, d: Deps): Promise<Response> {
  const p = await familyParent(req, d, ["owner", "caregiver"]);
  const b = await body(req);
  need(typeof b.code === "string", "code: the code the tablet shows");
  const name = typeof b.device_name === "string" && b.device_name.trim() ? b.device_name.trim().slice(0, 40) : "Tablet";
  const code = normalizeCode(b.code);
  const [r] = await d.sql`select * from pair_requests where code = ${code} and expires_at > ${nowTs(d)} and approved_at is null`;
  if (!r) throw new ApiError("not_found", "no such code, or it ran out: show a new one on the tablet");
  const [existing] = await d.sql`select family_id, removed_at from devices where id = ${r.dev}`;
  if (existing && existing.family_id !== p.familyId && !existing.removed_at) {
    throw new ApiError("conflict", "this tablet belongs to another family; remove it there first");
  }
  const token = "dt_" + hex(32);
  const hash = await sha256(token);
  await d.sql.begin(async (tx) => {
    await tx`insert into devices (id, family_id, game, name, token_hash, app, code, paired_at, removed_at)
      values (${r.dev}, ${p.familyId}, ${r.game}, ${name}, ${hash}, ${r.app}, ${r.app_code}, ${nowTs(d)}, null)
      on conflict (id) do update set family_id = excluded.family_id, game = excluded.game, name = excluded.name,
        token_hash = excluded.token_hash, app = excluded.app, code = excluded.code, paired_at = excluded.paired_at, removed_at = null`;
    await tx`update pair_requests set approved_by = ${p.userId}, approved_at = ${nowTs(d)}, family_id = ${p.familyId},
      device_name = ${name}, token_once = ${token} where id = ${r.id}`;
  });
  return json({ ok: true, dev: r.dev, name, game: r.game });
}

async function pairPoll(_req: Request, d: Deps, url: URL): Promise<Response> {
  const id = url.searchParams.get("pair_id") ?? "";
  need(/^pr_[0-9a-f]{32}$/.test(id), "pair_id");
  const [r] = await d.sql`select * from pair_requests where id = ${id}`;
  if (!r) throw new ApiError("not_found", "no such pairing; start again");
  if (!r.approved_at) {
    if (new Date(r.expires_at).getTime() < d.now()) {
      await d.sql`delete from pair_requests where id = ${id}`;
      return json({ state: "expired" });
    }
    return json({ state: "waiting", expires_in: Math.max(0, Math.round((new Date(r.expires_at).getTime() - d.now()) / 1000)) });
  }
  // approved: hand the token over once, then forget it
  await d.sql`delete from pair_requests where id = ${id}`;
  const children = await d.sql`select id as child, nickname, picture from children where family_id = ${r.family_id} order by created_at`;
  return json({ state: "approved", device_token: r.token_once, family: r.family_id, dev: r.dev, name: r.device_name, children: [...children] });
}

async function patchDevice(req: Request, d: Deps, dev: string): Promise<Response> {
  const p = await familyParent(req, d, ["owner", "caregiver"]);
  const b = await body(req);
  need(typeof b.name === "string" && b.name.trim().length >= 1 && b.name.trim().length <= 40, "name: 1 to 40 characters");
  const [r] = await d.sql`update devices set name = ${b.name.trim()} where id = ${dev} and family_id = ${p.familyId} and removed_at is null returning id as dev, name`;
  if (!r) throw new ApiError("not_found", "no such device in this family");
  return json(r);
}

/** Removes a device: its token stops working and its next call hears "gone". */
async function removeDevice(req: Request, d: Deps, dev: string): Promise<Response> {
  const p = await familyParent(req, d, ["owner", "caregiver"]);
  // the hash stays, so the old token is recognised and answered "gone"
  const [r] = await d.sql`update devices set removed_at = ${nowTs(d)}
    where id = ${dev} and family_id = ${p.familyId} and removed_at is null returning id`;
  if (!r) throw new ApiError("not_found", "no such device in this family");
  return json({ removed: true });
}

/** The device's profile map plus the family's children, for GET and PUT. */
async function profilesView(sql: Sql, dev: string, familyId: string): Promise<Row> {
  const rows = await sql`select profile, child_id as child, nickname, picture, guest from device_profiles where dev = ${dev} order by profile`;
  const children = await sql`select id as child, nickname, picture from children where family_id = ${familyId} order by created_at`;
  return { profiles: [...rows], children: [...children] };
}

/** GET /v1/devices/{dev}/profiles (profile plan C3): a paired tablet reads its
 * map and the family's children again, so it sees a child added or removed
 * on the web after pairing. */
async function getProfiles(req: Request, d: Deps, dev: string): Promise<Response> {
  const me = await device(req, d);
  need(me.id === dev, "a device reads only its own profiles", "forbidden");
  return json(await profilesView(d.sql, dev, me.familyId));
}

/** PUT /v1/devices/{dev}/profiles. An item with "child": "new" (profile plan
 * C4) makes the family child from its nickname and picture and maps it in the
 * same call. Sent again, it finds the child that profile already maps to and
 * makes no second one. */
async function putProfiles(req: Request, d: Deps, dev: string): Promise<Response> {
  const me = await device(req, d);
  need(me.id === dev, "a device sets only its own profiles", "forbidden");
  const b = await body(req);
  need(Array.isArray(b.profiles) && b.profiles.length <= 16, "profiles: a list of at most 16");
  for (const p of b.profiles) {
    need(p && typeof p.profile === "string" && PROFILE.test(p.profile), "profile: p_ + 12 hex");
    if (p.child === "new" && p.guest !== true) {
      need(typeof p.nickname === "string" && p.nickname.trim().length >= 1 && p.nickname.trim().length <= 24, "a new child needs a nickname of 1 to 24 characters");
      need(p.picture === undefined || (typeof p.picture === "string" && PICTURE.test(p.picture)), "picture: a picture id");
    }
  }
  const created: Row[] = [];
  const out = await d.sql.begin(async (tx) => {
    // one writer per family at a time, so two tablets can't pass the limit together
    await tx`select id from families where id = ${me.familyId} for update`;
    const kids = new Set((await tx`select id from children where family_id = ${me.familyId}`).map((r: Row) => r.id));
    const mapped = new Map((await tx`select profile, child_id from device_profiles where dev = ${dev}`).map((r: Row) => [r.profile, r.child_id]));
    for (const p of b.profiles) {
      const guest = p.guest === true;
      let child = guest ? null : (p.child ?? null);
      if (child === "new") {
        const had = mapped.get(p.profile);
        if (had && kids.has(had)) child = had;
        else {
          if (kids.size >= MAX_CHILDREN) throw new ApiError("conflict", `at most ${MAX_CHILDREN} children`, { reason: "children_limit", profile: p.profile });
          const [c] = await tx`insert into children (family_id, nickname, picture)
            values (${me.familyId}, ${p.nickname.trim()}, ${p.picture ?? "fox"}) returning id`;
          child = c.id as string;
          kids.add(child);
          created.push({ profile: p.profile, child });
        }
      }
      need(child === null || kids.has(child), `child ${child} is not in this family`);
      mapped.set(p.profile, child);
      await tx`insert into device_profiles (dev, profile, child_id, nickname, picture, guest, updated_at)
        values (${dev}, ${p.profile}, ${child}, ${String(p.nickname ?? "").slice(0, 24)}, ${String(p.picture ?? "").slice(0, 32)}, ${guest}, ${nowTs(d)})
        on conflict (dev, profile) do update set child_id = excluded.child_id, nickname = excluded.nickname,
          picture = excluded.picture, guest = excluded.guest, updated_at = excluded.updated_at`;
    }
    return await profilesView(tx as unknown as Sql, dev, me.familyId);
  });
  return json({ ...out, created });
}

// ------------------------------------------------------------------ events

async function putEvents(req: Request, d: Deps, game: string, dev: string, first: number, last: number): Promise<Response> {
  const me = await device(req, d);
  need(me.id === dev, "a device uploads only its own events", "forbidden");
  need(me.game === game, "this device was paired for another game", "forbidden");
  need(Number.isSafeInteger(first) && Number.isSafeInteger(last) && first >= 1 && last >= first, "sequence range");
  const raw = new Uint8Array(await req.arrayBuffer());
  const zipped = (req.headers.get("content-encoding") ?? "").includes("gzip");
  if (raw.length > (zipped ? MAX_EVENTS_GZIP : MAX_EVENTS_TEXT)) throw new ApiError("too_large", "batch too big: send fewer lines");
  const [dup] = await d.sql`select lines from uploads where game = ${game} and dev = ${dev} and first_seq = ${first} and last_seq = ${last}`;
  if (dup) return json({ stored: false, duplicate: true, lines: dup.lines });
  const text = new TextDecoder().decode(zipped ? await gunzip(raw, MAX_EVENTS_TEXT) : raw);
  const lines = text.split("\n").filter((l) => l.trim());
  need(lines.length > 0, "no lines");
  const profiles = new Set<string>();
  for (const [i, l] of lines.entries()) {
    let e: Row;
    try {
      e = JSON.parse(l);
    } catch {
      throw new ApiError("bad_request", `line ${i + 1} is not JSON`);
    }
    need(e && typeof e === "object" && !Array.isArray(e), `line ${i + 1} is not an object`);
    // every event version ever shipped is stored; v2 lines are checked against the contract
    if (e.v === 2) {
      const errs = schemaErrors(e, SCHEMAS.event_v2);
      if (errs.length) throw new ApiError("bad_request", `line ${i + 1}: ${errs.slice(0, 3).join("; ")}`);
    }
    if ("seq" in e) need(Number.isInteger(e.seq) && e.seq >= first && e.seq <= last, `line ${i + 1}: seq outside ${first}-${last}`);
    if ("dev" in e) need(e.dev === dev, `line ${i + 1}: dev is not ${dev}`);
    if (typeof e.profile === "string") profiles.add(e.profile);
  }
  const path = `events/${me.familyId}/${game}/${dev}/${first}-${last}.jsonl.gz`;
  await d.blobs.put(path, zipped ? raw : await gzip(raw), "application/gzip");
  const mapped = profiles.size
    ? await d.sql`select profile, child_id from device_profiles where dev = ${dev} and profile in ${d.sql([...profiles])}`
    : [];
  const children = [...new Set(mapped.filter((m: Row) => m.child_id).map((m: Row) => m.child_id as string))];
  const unmapped = [...profiles].filter((p) => !mapped.some((m: Row) => m.profile === p));
  await d.sql.begin(async (tx) => {
    await tx`insert into uploads (game, dev, first_seq, last_seq, family_id, path, bytes, lines, received_at)
      values (${game}, ${dev}, ${first}, ${last}, ${me.familyId}, ${path}, ${raw.length}, ${lines.length}, ${nowTs(d)})`;
    for (const c of children) {
      await tx`insert into upload_children values (${game}, ${dev}, ${first}, ${last}, ${c})`;
      await tx`update children set last_play_at = ${nowTs(d)} where id = ${c}`;
    }
    await tx`update families set last_active_at = ${nowTs(d)}, warned_at = null where id = ${me.familyId}`;
  });
  return json({ stored: true, lines: lines.length, children, unmapped_profiles: unmapped }, 201);
}

// ------------------------------------------------------------------ play records

const MAX_RECORD_DAYS = 400;
const MAX_RECORD_LINES = 5000;

/**
 * A parent reads one child's play log lines for one game: every line from a
 * profile that is mapped to the child now (so lines sent before the mapping
 * count too), newest first. Guest lines never reach the server.
 */
async function getRecords(req: Request, d: Deps, url: URL, childId: string, game: string): Promise<Response> {
  const a = await childAccess(req, d, childId);
  if (!a.parent) throw new ApiError("forbidden", "play records are for parents");
  need(GAME.test(game), "bad game id");
  const days = Number(url.searchParams.get("days") ?? "30");
  need(Number.isInteger(days) && days >= 1 && days <= MAX_RECORD_DAYS, `days: 1 to ${MAX_RECORD_DAYS}`);
  const limit = Number(url.searchParams.get("limit") ?? "2000");
  need(Number.isInteger(limit) && limit >= 1 && limit <= MAX_RECORD_LINES, `limit: 1 to ${MAX_RECORD_LINES}`);
  const mine = await d.sql`select p.dev, p.profile from device_profiles p join devices v on v.id = p.dev
    where p.child_id = ${childId} and v.family_id = ${a.familyId}`;
  const keys = new Set(mine.map((r: Row) => `${r.dev}/${r.profile}`));
  const devs = [...new Set(mine.map((r: Row) => r.dev as string))];
  const since = new Date(d.now() - days * 86400 * 1000);
  const uploads = devs.length
    ? await d.sql`select dev, path from uploads where family_id = ${a.familyId} and game = ${game}
        and dev in ${d.sql(devs)} and received_at >= ${since} order by received_at desc, last_seq desc`
    : [];
  const out: Row[] = [];
  let truncated = false;
  for (const u of uploads) {
    const raw = await d.blobs.get(u.path);
    if (!raw) continue;
    const text = new TextDecoder().decode(await gunzip(raw, MAX_EVENTS_TEXT));
    const batch: Row[] = [];
    for (const l of text.split("\n")) {
      if (!l.trim()) continue;
      try {
        const e = JSON.parse(l);
        if (e && typeof e.profile === "string" && keys.has(`${e.dev ?? u.dev}/${e.profile}`)) batch.push(e);
      } catch {
        // a line the server could not read is skipped, never fatal
      }
    }
    batch.sort((x, y) => (y.seq ?? 0) - (x.seq ?? 0));
    for (const e of batch) {
      if (out.length >= limit) {
        truncated = true;
        break;
      }
      out.push(e);
    }
    if (truncated) break;
  }
  out.sort((x, y) => (y.t ?? 0) - (x.t ?? 0) || (y.seq ?? 0) - (x.seq ?? 0));
  return json({ child: childId, game, days, lines: out, truncated });
}

// ------------------------------------------------------------------ snapshots

async function getSnapshots(req: Request, d: Deps, childId: string, game: string): Promise<Response> {
  await childAccess(req, d, childId);
  const rows = await d.sql`select dev, rev, saved_at, path from snapshots where child_id = ${childId} and game = ${game} order by saved_at desc`;
  const out = [];
  for (const r of rows) {
    const raw = await d.blobs.get(r.path);
    if (raw) out.push(JSON.parse(new TextDecoder().decode(raw)));
  }
  return json({ child: childId, game, snapshots: out });
}

async function putSnapshot(req: Request, d: Deps, childId: string, game: string, dev: string): Promise<Response> {
  const a = await childAccess(req, d, childId);
  need(a.device && a.device.id === dev, "a device uploads only its own snapshot", "forbidden");
  need(a.device!.game === game, "this device was paired for another game", "forbidden");
  const snap = await body(req, MAX_SNAPSHOT);
  const errs = schemaErrors(snap, SCHEMAS.snapshot_v1);
  if (errs.length) throw new ApiError("bad_request", errs.slice(0, 3).join("; "));
  need(snap.game === game && snap.dev === dev, "snapshot game and dev must match the path");
  need(snap.child === null || snap.child === undefined || snap.child === childId, "snapshot child must match the path");
  const [cur] = await d.sql`select rev from snapshots where child_id = ${childId} and game = ${game} and dev = ${dev}`;
  if (cur && snap.rev <= cur.rev) throw new ApiError("conflict", "an equal or newer snapshot is stored", { stored_rev: cur.rev });
  const path = `snapshots/${a.familyId}/${childId}/${game}/${dev}.json`;
  await d.blobs.put(path, new TextEncoder().encode(JSON.stringify({ ...snap, child: childId })), "application/json");
  await d.sql`insert into snapshots (child_id, game, dev, rev, path, saved_at, received_at)
    values (${childId}, ${game}, ${dev}, ${snap.rev}, ${path}, ${snap.saved_at}, ${nowTs(d)})
    on conflict (child_id, game, dev) do update set rev = excluded.rev, path = excluded.path,
      saved_at = excluded.saved_at, received_at = excluded.received_at`;
  return json({ stored: true, rev: snap.rev });
}

// ------------------------------------------------------------------ settings

async function settingsDoc(sql: Sql, childId: string, game: string): Promise<Row> {
  const rows = await sql`select key, value, rev, at, by from settings where child_id = ${childId} and game = ${game}`;
  const fields: Row = {};
  let rev = 0;
  for (const r of rows) {
    fields[r.key] = { value: r.value, rev: r.rev, at: Number(r.at), by: r.by };
    rev = Math.max(rev, r.rev);
  }
  return { schema: "family.settings", v: 1, child: childId, game, rev, fields };
}

async function getSettings(req: Request, d: Deps, childId: string, game: string): Promise<Response> {
  need(GAME.test(game), "game");
  await childAccess(req, d, childId);
  return json(await settingsDoc(d.sql, childId, game));
}

function checkValue(spec: Row, v: unknown): boolean {
  switch (spec.type) {
    case "int":
      return Number.isInteger(v) && (spec.min === undefined || (v as number) >= spec.min) && (spec.max === undefined || (v as number) <= spec.max);
    case "bool":
      return typeof v === "boolean";
    case "time":
      return v === null || (typeof v === "string" && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v));
    case "enum":
      return Array.isArray(spec.options) && spec.options.includes(v);
  }
  return false;
}

async function patchSettings(req: Request, d: Deps, childId: string, game: string): Promise<Response> {
  need(GAME.test(game), "game");
  const a = await childAccess(req, d, childId);
  if (a.parent) need(["owner", "caregiver"].includes(a.parent.role!), "viewers can't change settings", "forbidden");
  if (a.device) need(a.device.game === game, "this device was paired for another game", "forbidden");
  const b = await body(req);
  need(b.fields && typeof b.fields === "object" && !Array.isArray(b.fields), "fields: {key: {value}}");
  const [m] = await d.sql`select body from manifests where game = ${game} order by code desc limit 1`;
  const specs: Row[] = m?.body?.settings ?? [];
  for (const [k, f] of Object.entries(b.fields as Row)) {
    const spec = specs.find((s) => s.key === k);
    if (!spec || spec.scope === "device") throw new ApiError("unprocessable", `${game} has no setting ${k}`);
    need(f && typeof f === "object" && "value" in f, `${k}: {value}`);
    if (!checkValue(spec, f.value)) throw new ApiError("unprocessable", `${k}: not a valid ${spec.type}`);
  }
  await d.sql.begin(async (tx) => {
    // one new revision for the whole change; per field, the latest change wins
    await tx`select pg_advisory_xact_lock(hashtext(${childId + "/" + game}))`;
    const [{ rev }] = await tx`select coalesce(max(rev), 0)::int as rev from settings where child_id = ${childId} and game = ${game}`;
    for (const [k, f] of Object.entries(b.fields as Row)) {
      await tx`insert into settings (child_id, game, key, value, rev, at, by)
        values (${childId}, ${game}, ${k}, ${tx.json(f.value)}, ${rev + 1}, ${secs(d)}, ${a.by})
        on conflict (child_id, game, key) do update set value = excluded.value, rev = excluded.rev, at = excluded.at, by = excluded.by`;
    }
  });
  return json(await settingsDoc(d.sql, childId, game));
}

// ------------------------------------------------------------------ manifests

async function putManifest(req: Request, d: Deps, game: string, code: number): Promise<Response> {
  const key = authHeader(req, "Publisher");
  if (!d.publishKey || !key || key !== d.publishKey) throw new ApiError("unauthorized", "publisher key");
  const m = await body(req, 262144);
  const errs = schemaErrors(m, SCHEMAS.manifest_v1);
  if (errs.length) throw new ApiError("bad_request", errs.slice(0, 3).join("; "));
  need(m.game === game && m.code === code, "manifest game and code must match the path");
  await d.sql`insert into manifests (game, code, body, received_at) values (${game}, ${code}, ${d.sql.json(m)}, ${nowTs(d)})
    on conflict (game, code) do update set body = excluded.body, received_at = excluded.received_at`;
  return json({ stored: true }, 201);
}

async function getManifest(d: Deps, game: string, which: string): Promise<Response> {
  const rows = which === "latest"
    ? await d.sql`select body from manifests where game = ${game} order by code desc limit 1`
    : await d.sql`select body from manifests where game = ${game} and code = ${Number(which)}`;
  if (!rows.length) throw new ApiError("not_found", "no manifest");
  return json(rows[0].body);
}

// ------------------------------------------------------------------ retention

/** The scheduled job (contract/retention.md): event batches 24 months after
 * the child's last play, idle families after a warning, stale pairings. */
export async function retention(d: Deps): Promise<Row> {
  const cutoff = new Date(d.now());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - RETENTION_MONTHS);
  const graceCutoff = new Date(d.now() - IDLE_DELETE_DAYS * 86400_000);
  await d.sql`delete from pair_requests where expires_at < ${nowTs(d)}`;
  // a batch goes when none of its children has played since the cutoff
  const old = await d.sql`select u.game, u.dev, u.first_seq, u.last_seq, u.path from uploads u
    where u.received_at < ${cutoff}
      and not exists (select 1 from upload_children k join children c on c.id = k.child_id
        where (k.game, k.dev, k.first_seq, k.last_seq) = (u.game, u.dev, u.first_seq, u.last_seq)
          and c.last_play_at >= ${cutoff})`;
  if (old.length) {
    await d.blobs.remove(old.map((r: Row) => r.path));
    for (const r of old) {
      await d.sql`delete from uploads where game = ${r.game} and dev = ${r.dev} and first_seq = ${r.first_seq} and last_seq = ${r.last_seq}`;
    }
  }
  // idle families: warn first (the email comes with the weekly email job), delete after the grace period
  const warned = await d.sql`update families set warned_at = ${nowTs(d)}
    where last_active_at < ${cutoff} and warned_at is null returning id`;
  const doomed = await d.sql`select id from families where last_active_at < ${cutoff} and warned_at < ${graceCutoff}`;
  for (const f of doomed) await purgeFamily(d, f.id);
  return { batches_deleted: old.length, families_warned: warned.length, families_deleted: doomed.length };
}

// ------------------------------------------------------------------ the router

export async function handle(req: Request, d: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  // the function is served at .../functions/v1/api; everything from /v1/ on is ours
  const found = /(?:^|\/api)\/v1(\/.*)$/.exec(url.pathname);
  const path = found ? found[1] : url.pathname;
  const seg = path.split("/").filter(Boolean);
  const m = req.method;
  const route = (method: string, pattern: string): string[] | null => {
    if (method !== m) return null;
    const ps = pattern.split("/").filter(Boolean);
    if (ps.length !== seg.length) return null;
    const out: string[] = [];
    for (let i = 0; i < ps.length; i++) {
      if (ps[i].startsWith(":")) out.push(decodeURIComponent(seg[i]));
      else if (ps[i] !== seg[i]) return null;
    }
    return out;
  };
  try {
    let a: string[] | null;
    if ((a = route("GET", "/health"))) return json({ ok: true, api: "v1" });
    if ((a = route("POST", "/family"))) return await createFamily(req, d);
    if ((a = route("GET", "/family"))) return await getFamily(req, d);
    if ((a = route("DELETE", "/family"))) return await deleteFamily(req, d);
    if ((a = route("GET", "/family/export"))) return await exportFamily(req, d);
    if ((a = route("POST", "/family/children"))) return await addChild(req, d);
    if ((a = route("PATCH", "/children/:c"))) return await patchChild(req, d, a[0]);
    if ((a = route("DELETE", "/children/:c"))) return await deleteChild(req, d, a[0]);
    if ((a = route("POST", "/devices/pair/start"))) return await pairStart(req, d);
    if ((a = route("POST", "/devices/pair/approve"))) return await pairApprove(req, d);
    if ((a = route("GET", "/devices/pair/poll"))) return await pairPoll(req, d, url);
    if ((a = route("PATCH", "/devices/:dev"))) return await patchDevice(req, d, a[0]);
    if ((a = route("DELETE", "/devices/:dev"))) return await removeDevice(req, d, a[0]);
    if ((a = route("GET", "/devices/:dev/profiles"))) return await getProfiles(req, d, a[0]);
    if ((a = route("PUT", "/devices/:dev/profiles"))) return await putProfiles(req, d, a[0]);
    if ((a = route("PUT", "/events/:game/:dev/:range"))) {
      const r = /^(\d+)-(\d+)$/.exec(a[2]);
      need(r, "range: first-last");
      return await putEvents(req, d, a[0], a[1], Number(r[1]), Number(r[2]));
    }
    if ((a = route("GET", "/children/:c/games/:g/records"))) return await getRecords(req, d, url, a[0], a[1]);
    if ((a = route("GET", "/children/:c/games/:g/snapshots"))) return await getSnapshots(req, d, a[0], a[1]);
    if ((a = route("PUT", "/children/:c/games/:g/snapshots/:dev"))) return await putSnapshot(req, d, a[0], a[1], a[2]);
    if ((a = route("GET", "/children/:c/games/:g/settings"))) return await getSettings(req, d, a[0], a[1]);
    if ((a = route("PATCH", "/children/:c/games/:g/settings"))) return await patchSettings(req, d, a[0], a[1]);
    if ((a = route("PUT", "/games/:g/manifests/:code"))) {
      need(/^\d+$/.test(a[1]), "code");
      return await putManifest(req, d, a[0], Number(a[1]));
    }
    if ((a = route("GET", "/games/:g/manifests/:which"))) return await getManifest(d, a[0], a[1]);
    if ((a = route("POST", "/admin/retention"))) {
      const key = authHeader(req, "Cron");
      if (!d.cronKey || key !== d.cronKey) throw new ApiError("unauthorized", "cron key");
      return json(await retention(d));
    }
    throw new ApiError("not_found", `no route ${m} /v1${path}`);
  } catch (e) {
    if (e instanceof ApiError) return errorResponse(e);
    console.error(e);
    return json({ error: "internal", detail: "something went wrong" }, 500);
  }
}
