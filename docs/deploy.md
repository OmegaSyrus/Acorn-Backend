# Deploying

Two Supabase projects, both in the Canada region (`ca-central-1`):
**staging** (free plan while building; it pauses after a week idle) and
**production** (Pro, $25 a month, once real families use it). The domain is
Terrence's to-do; until then the API lives at
`https://<project-ref>.supabase.co/functions/v1/api/v1`.

## One-time setup per project

1. Create the project in the Supabase dashboard (region Canada).
2. Auth → Providers: **Email** on (magic link, no passwords); **Google** on
   with a Google Cloud OAuth client (type "Web application"; its authorised
   redirect URI is the callback URL Supabase shows on that page).
3. Auth → URL configuration: the parent web app's address as Site URL.
4. Link and push the database:

   ```sh
   npx supabase@2 login            # or SUPABASE_ACCESS_TOKEN in the environment
   npx supabase@2 link --project-ref <ref>
   npx supabase@2 db push          # runs supabase/migrations/
   ```

   The migration also makes the private `family` storage bucket.
5. Function secrets (SUPABASE_URL, SUPABASE_DB_URL and the keys are set by
   Supabase itself):

   ```sh
   npx supabase@2 secrets set ACORN_PUBLISH_KEY=<random> ACORN_CRON_KEY=<random> \
     ACORN_PAIR_URL=https://<parent app>/pair
   ```

6. Deploy the function: `npx supabase@2 functions deploy api --no-verify-jwt`.
7. Schedule retention daily (SQL editor; needs the `pg_cron` and `pg_net`
   extensions from Database → Extensions):

   ```sql
   select cron.schedule('acorn-retention', '17 7 * * *', $$
     select net.http_post(
       url := 'https://<ref>.supabase.co/functions/v1/api/v1/admin/retention',
       headers := jsonb_build_object('authorization', 'Cron ' ||
         (select decrypted_secret from vault.decrypted_secrets where name = 'acorn_cron_key')),
       body := '{}'::jsonb
     )
   $$);
   ```

8. Schedule the weekly email (Mondays 13:00 UTC, morning in Canada):

   ```sql
   select cron.schedule('acorn-weekly', '0 13 * * 1', $$
     select net.http_post(
       url := 'https://<ref>.supabase.co/functions/v1/api/v1/admin/weekly',
       headers := jsonb_build_object('authorization', 'Cron ' ||
         (select decrypted_secret from vault.decrypted_secrets where name = 'acorn_cron_key')),
       body := '{}'::jsonb
     )
   $$);
   ```

   It sends nothing until a mail account is set: make a Resend account
   (https://resend.com, free for 3,000 emails a month), verify the sending
   domain, then
   `npx supabase@2 secrets set RESEND_API_KEY=<key> ACORN_MAIL_FROM="Acorn <reports@<domain>>" ACORN_APP_URL=<parent app address>`.
   Use the same account as Supabase Auth's custom SMTP (smtp.resend.com,
   user `resend`, the key as password) so sign-in emails stop being
   rate-limited and can carry the 6-digit code.
9. Publish each game build's manifest from its CI:
   `curl -X PUT -H "Authorization: Publisher $ACORN_PUBLISH_KEY" --data @manifest.json <base>/games/acorn-math/manifests/<code>`.

## Staging today

Staging is project `maphrtpqbqmjfmhgqonq` (region `us-east-2`, not Canada;
fine for staging, production should be made in `ca-central-1`). Deployed
2026-11-17: migration `20261117000000` applied, bucket `family`, secrets
`ACORN_PUBLISH_KEY` and `ACORN_CRON_KEY` set (copies in Vault as
`acorn_publish_key` and `acorn_cron_key`, Database → Vault), function `api`,
Email and Google sign-in on, daily retention job `acorn-retention` reading
the cron key from Vault.

From a cloud session, the database port 5432 is blocked, so `db push` fails.
Run the migration through the Management API instead (HTTPS):
`POST https://api.supabase.com/v1/projects/<ref>/database/query` with
`{"query": "<the migration SQL>"}` and the access token, then add its row to
`supabase_migrations.schema_migrations` so a later `db push` skips it.
`functions deploy api --no-verify-jwt --use-api` needs no Docker.

## Checking a deploy

`curl <base>/health` answers `{"ok":true,"api":"v1"}`. Then the pairing
round trip from the contract's `samples/api-pair.json` against staging.

## Secrets

Never commit keys. The service role key stays inside Supabase (the function
reads it from its environment). The parent web app uses only the anon key,
and row-level security limits what it can read.
