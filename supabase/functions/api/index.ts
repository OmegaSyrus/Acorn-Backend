// The /v1 API as one Supabase Edge Function: https://<project>.supabase.co/functions/v1/api/v1/...
// Deployed with verify_jwt = false (supabase/config.toml): games send a
// device token, not a Supabase sign-in, and every handler checks its own caller.
import postgres from "npm:postgres@3.4.5";
import { handle } from "../_shared/api.ts";
import { resendMailer, SupabaseBlobs, supabaseParentUser } from "../_shared/deps.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 3, prepare: false, idle_timeout: 20 });

const deps = {
  sql,
  blobs: new SupabaseBlobs(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
  parentUser: supabaseParentUser(url, Deno.env.get("SUPABASE_ANON_KEY")!),
  now: () => Date.now(),
  publishKey: Deno.env.get("ACORN_PUBLISH_KEY") || undefined,
  cronKey: Deno.env.get("ACORN_CRON_KEY") || undefined,
  pairUrlBase: Deno.env.get("ACORN_PAIR_URL") || undefined,
  appUrl: Deno.env.get("ACORN_APP_URL") || undefined,
  // the weekly email sends only once a mail account is set up
  mail: Deno.env.get("RESEND_API_KEY") && Deno.env.get("ACORN_MAIL_FROM")
    ? resendMailer(Deno.env.get("RESEND_API_KEY")!, Deno.env.get("ACORN_MAIL_FROM")!)
    : undefined,
};

Deno.serve((req) => handle(req, deps));
