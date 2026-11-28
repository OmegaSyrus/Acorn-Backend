-- Reports and the weekly email (parent app plan v2, thread 6).
-- The family's time zone decides where a report's week starts and how its
-- times read. Each adult turns the weekly email on or off for themselves.

alter table public.families add column tz text;

alter table public.adults
  add column weekly_email boolean not null default true,
  -- the last weekly email sent, so a cron that fires twice sends once
  add column weekly_sent_at timestamptz,
  -- "send me a test now", at most one every 10 minutes
  add column test_sent_at timestamptz;
