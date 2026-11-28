// What the /v1 handlers need from the outside world, so tests can swap in
// a local Postgres, files in memory and a fake sign-in check.
import type postgres from "npm:postgres@3.4.5";

export type Sql = postgres.Sql;

/** File storage for event batches and snapshots (Supabase Storage in production). */
export interface Blobs {
  put(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(path: string): Promise<Uint8Array | null>;
  remove(paths: string[]): Promise<void>;
}

export interface Deps {
  sql: Sql;
  blobs: Blobs;
  /** The signed-in adult's user id for a Supabase Auth access token, or null. */
  parentUser(token: string): Promise<string | null>;
  /** Milliseconds since 1970 (tests move the clock). */
  now(): number;
  /** Game builds publish manifests with "Authorization: Publisher <key>". */
  publishKey?: string;
  /** The scheduled retention job calls with "Authorization: Cron <key>". */
  cronKey?: string;
  /** Where a pairing QR points, e.g. https://parents.example/pair (optional). */
  pairUrlBase?: string;
  /** The parent web app's address, linked from emails (optional). */
  appUrl?: string;
  /** Sends one email (the weekly report). Unset: emails are previewed, never sent. */
  mail?: (m: Mail) => Promise<void>;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Sends through Resend's HTTP API (https://resend.com), from a verified sender. */
export function resendMailer(apiKey: string, from: string) {
  return async (m: Mail): Promise<void> => {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
    });
    if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    await r.body?.cancel();
  };
}

/** Files kept in memory (tests and local runs). */
export class MemoryBlobs implements Blobs {
  files = new Map<string, Uint8Array>();
  put(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes);
    return Promise.resolve();
  }
  get(path: string): Promise<Uint8Array | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }
  remove(paths: string[]): Promise<void> {
    for (const p of paths) this.files.delete(p);
    return Promise.resolve();
  }
}

/** Supabase Storage over its REST API, with the service role key. */
export class SupabaseBlobs implements Blobs {
  constructor(private url: string, private serviceKey: string, private bucket = "family") {}

  private headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.serviceKey}`, apikey: this.serviceKey, ...extra };
  }

  async put(path: string, bytes: Uint8Array, contentType: string): Promise<void> {
    const r = await fetch(`${this.url}/storage/v1/object/${this.bucket}/${path}`, {
      method: "POST",
      headers: this.headers({ "content-type": contentType, "x-upsert": "true" }),
      body: bytes,
    });
    if (!r.ok) throw new Error(`storage put ${path}: ${r.status} ${await r.text()}`);
  }

  async get(path: string): Promise<Uint8Array | null> {
    const r = await fetch(`${this.url}/storage/v1/object/${this.bucket}/${path}`, { headers: this.headers() });
    if (r.status === 404 || r.status === 400) {
      await r.body?.cancel();
      return null;
    }
    if (!r.ok) throw new Error(`storage get ${path}: ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  async remove(paths: string[]): Promise<void> {
    for (let i = 0; i < paths.length; i += 500) {
      const r = await fetch(`${this.url}/storage/v1/object/${this.bucket}`, {
        method: "DELETE",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ prefixes: paths.slice(i, i + 500) }),
      });
      if (!r.ok) throw new Error(`storage remove: ${r.status} ${await r.text()}`);
    }
  }
}

/** Checks a parent's access token with Supabase Auth. */
export function supabaseParentUser(url: string, anonKey: string) {
  return async (token: string): Promise<string | null> => {
    const r = await fetch(`${url}/auth/v1/user`, { headers: { authorization: `Bearer ${token}`, apikey: anonKey } });
    if (!r.ok) {
      await r.body?.cancel();
      return null;
    }
    const u = await r.json();
    return typeof u?.id === "string" ? u.id : null;
  };
}
