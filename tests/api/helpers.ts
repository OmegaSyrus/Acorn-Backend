// A fresh database per test (the Supabase shim plus every migration on a
// plain Postgres), files in memory, a fake sign-in and a clock tests move.
//   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432 deno task test
import postgres from "npm:postgres@3.4.5";
import { handle } from "../../supabase/functions/_shared/api.ts";
import { type Deps, MemoryBlobs } from "../../supabase/functions/_shared/deps.ts";

const BASE = Deno.env.get("TEST_DATABASE_URL") ?? "postgresql://postgres@127.0.0.1:54329";
const root = new URL("../../", import.meta.url);

export const PUBLISH_KEY = "test-publish-key";
export const CRON_KEY = "test-cron-key";

export interface World {
  deps: Deps & { blobs: MemoryBlobs };
  clock: { ms: number };
  call(method: string, path: string, opts?: { auth?: string; body?: unknown; raw?: Uint8Array; headers?: Record<string, string> }): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

let n = 0;

export async function world(): Promise<World> {
  const name = `acorn_t_${Date.now()}_${n++}_${Math.floor(Math.random() * 1e6)}`;
  const admin = postgres(`${BASE}/postgres`, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database ${name}`);
  await admin.end();
  const sql = postgres(`${BASE}/${name}`, { max: 4, onnotice: () => {} });
  await sql.unsafe(Deno.readTextFileSync(new URL("tests/sql/supabase_shim.sql", root)));
  const migrations = [...Deno.readDirSync(new URL("supabase/migrations/", root))].map((e) => e.name).sort();
  for (const m of migrations) await sql.unsafe(Deno.readTextFileSync(new URL(`supabase/migrations/${m}`, root)));
  const clock = { ms: Date.UTC(2026, 10, 17, 12, 0, 0) };
  const deps = {
    sql,
    blobs: new MemoryBlobs(),
    // a test token is "parent:<user uuid>"
    parentUser: (t: string) => Promise.resolve(t.startsWith("parent:") ? t.slice(7) : null),
    now: () => clock.ms,
    publishKey: PUBLISH_KEY,
    cronKey: CRON_KEY,
    pairUrlBase: "https://parents.example.invalid/pair",
  };
  return {
    deps,
    clock,
    async call(method, path, opts = {}) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (opts.auth) headers.authorization = opts.auth;
      let reqBody: BodyInit | undefined;
      if (opts.raw) reqBody = opts.raw;
      else if (opts.body !== undefined) {
        reqBody = JSON.stringify(opts.body);
        headers["content-type"] = "application/json";
      }
      const r = await handle(new Request(`http://localhost/functions/v1/api/v1${path}`, { method, headers, body: reqBody }), deps);
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    },
    async close() {
      await sql.end();
      const a = postgres(`${BASE}/postgres`, { max: 1, onnotice: () => {} });
      await a.unsafe(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

/** A signed-in adult with a family. Returns their auth header. */
export async function parentWithFamily(w: World, id: string, email = `${id.slice(-4)}@example.invalid`): Promise<string> {
  await w.deps.sql`insert into auth.users (id, email) values (${id}, ${email})`;
  const auth = `Bearer parent:${id}`;
  const r = await w.call("POST", "/family", { auth, body: { consent_version: "2026-11-v1" } });
  if (r.status !== 201) throw new Error(`family: ${JSON.stringify(r.body)}`);
  return auth;
}

/** Pairs a device into the parent's family; returns its auth header. */
export async function pairedDevice(w: World, parent: string, dev: string, game = "acorn-math"): Promise<string> {
  const s = await w.call("POST", "/devices/pair/start", { body: { game, dev, app: "0.24.0", code: 43 } });
  const a = await w.call("POST", "/devices/pair/approve", { auth: parent, body: { code: s.body.code, device_name: "Kitchen tablet" } });
  if (a.status !== 200) throw new Error(`approve: ${JSON.stringify(a.body)}`);
  const p = await w.call("GET", `/devices/pair/poll?pair_id=${s.body.pair_id}`);
  return `Device ${p.body.device_token}`;
}

export async function gzip(text: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
}

export async function gunzipText(bytes: Uint8Array): Promise<string> {
  return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

export function sample(name: string): any {
  return JSON.parse(Deno.readTextFileSync(new URL(`contract/samples/${name}`, root)));
}

export function sampleLines(): any[] {
  return Deno.readTextFileSync(new URL("contract/samples/play_log.v2.jsonl", root)).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}
