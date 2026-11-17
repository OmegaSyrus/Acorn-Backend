-- Backend core (parent app plan v2, thread 3): families, adults, children,
-- devices, pairing, the profile-to-child index, settings, upload and
-- snapshot indexes, manifests and consent records.
--
-- The /v1 Edge Function connects as the database owner (SUPABASE_DB_URL) and
-- is the only writer for devices, pairing, uploads, snapshots and manifests.
-- The parent web app reads with the signed-in adult's token, limited by the
-- row-level security policies at the end: an adult sees only their family.
-- Ids follow contract/README.md and are never reused.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tables

create table public.families (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  region         text not null default 'ca',
  last_active_at timestamptz not null default now(),
  -- the retention job's warning email before an idle family is deleted
  warned_at      timestamptz
);

create table public.adults (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  family_id  uuid not null references public.families (id) on delete cascade,
  role       text not null check (role in ('owner', 'caregiver', 'viewer')),
  created_at timestamptz not null default now()
);
create index adults_family on public.adults (family_id);

create table public.children (
  id           text primary key default ('c_' || encode(gen_random_bytes(6), 'hex')) check (id ~ '^c_[0-9a-f]{12}$'),
  family_id    uuid not null references public.families (id) on delete cascade,
  nickname     text not null check (char_length(nickname) between 1 and 24),
  birth_year   int check (birth_year between 2000 and 2100),
  picture      text not null default 'fox' check (picture ~ '^[a-z0-9_]{1,32}$'),
  created_at   timestamptz not null default now(),
  last_play_at timestamptz
);
create index children_family on public.children (family_id);

create table public.devices (
  id           text primary key check (id ~ '^d_[0-9a-f]{16}$'),
  family_id    uuid not null references public.families (id) on delete cascade,
  game         text not null check (game ~ '^[a-z][a-z0-9-]{1,31}$'),
  name         text not null default 'Tablet' check (char_length(name) between 1 and 40),
  token_hash   text unique,
  app          text,
  code         int,
  paired_at    timestamptz not null default now(),
  last_seen_at timestamptz,
  -- a parent removed it: its token stops working and the game hears "gone"
  removed_at   timestamptz
);
create index devices_family on public.devices (family_id);

create table public.device_profiles (
  dev        text not null references public.devices (id) on delete cascade,
  profile    text not null check (profile ~ '^p_[0-9a-f]{12}$'),
  child_id   text references public.children (id) on delete set null,
  nickname   text not null default '',
  picture    text not null default '',
  guest      boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (dev, profile),
  check (not guest or child_id is null)
);
create index device_profiles_child on public.device_profiles (child_id);

create table public.pair_requests (
  id           text primary key,              -- random, the poll's secret
  code         text not null unique,          -- what the tablet shows: K7Q-42M
  game         text not null,
  dev          text not null check (dev ~ '^d_[0-9a-f]{16}$'),
  app          text,
  app_code     int,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  approved_by  uuid references auth.users (id) on delete cascade,
  approved_at  timestamptz,
  family_id    uuid references public.families (id) on delete cascade,
  device_name  text,
  -- handed to the tablet once by the poll, then cleared
  token_once   text
);

create table public.settings (
  child_id text not null references public.children (id) on delete cascade,
  game     text not null,
  key      text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  value    jsonb,
  rev      int not null check (rev >= 1),
  at       bigint not null,
  by       text not null check (by ~ '^(parent|device:d_[0-9a-f]{16})'),
  primary key (child_id, game, key)
);

create table public.uploads (
  game        text not null,
  dev         text not null references public.devices (id) on delete cascade,
  first_seq   bigint not null check (first_seq >= 1),
  last_seq    bigint not null,
  family_id   uuid not null references public.families (id) on delete cascade,
  path        text not null,
  bytes       int not null,
  lines       int not null,
  received_at timestamptz not null default now(),
  primary key (game, dev, first_seq, last_seq),
  check (last_seq >= first_seq)
);
create index uploads_family on public.uploads (family_id);

-- which children an upload's lines were about, for per-child retention and delete
create table public.upload_children (
  game      text not null,
  dev       text not null,
  first_seq bigint not null,
  last_seq  bigint not null,
  child_id  text not null references public.children (id) on delete cascade,
  primary key (game, dev, first_seq, last_seq, child_id),
  foreign key (game, dev, first_seq, last_seq) references public.uploads on delete cascade
);
create index upload_children_child on public.upload_children (child_id);

create table public.snapshots (
  child_id    text not null references public.children (id) on delete cascade,
  game        text not null,
  dev         text not null,
  rev         int not null,
  path        text not null,
  saved_at    bigint not null,
  received_at timestamptz not null default now(),
  primary key (child_id, game, dev)
);

create table public.manifests (
  game        text not null check (game ~ '^[a-z][a-z0-9-]{1,31}$'),
  code        int not null check (code >= 1),
  body        jsonb not null,
  received_at timestamptz not null default now(),
  primary key (game, code)
);

create table public.consents (
  id        bigserial primary key,
  family_id uuid not null references public.families (id) on delete cascade,
  user_id   uuid references auth.users (id) on delete set null,
  version   text not null,
  method    text not null,
  at        timestamptz not null default now()
);

-- ---------------------------------------------------------------- helpers

-- The signed-in adult's family, for the policies (security definer so the
-- policies on adults don't recurse).
create function public.my_family() returns uuid
language sql stable security definer set search_path = public as $$
  select family_id from public.adults where user_id = auth.uid()
$$;

create function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.adults where user_id = auth.uid()
$$;

revoke all on function public.my_family() from public;
revoke all on function public.my_role() from public;
grant execute on function public.my_family() to authenticated;
grant execute on function public.my_role() to authenticated;

-- ---------------------------------------------------------------- row-level security

alter table public.families        enable row level security;
alter table public.adults          enable row level security;
alter table public.children        enable row level security;
alter table public.devices         enable row level security;
alter table public.device_profiles enable row level security;
alter table public.pair_requests   enable row level security;
alter table public.settings        enable row level security;
alter table public.uploads         enable row level security;
alter table public.upload_children enable row level security;
alter table public.snapshots       enable row level security;
alter table public.manifests       enable row level security;
alter table public.consents        enable row level security;

-- Nothing for anon. Signed-in adults read their own family's rows. Writes
-- that the web app makes directly: children (owner and caregiver) and a
-- device's name. Everything else is written by the /v1 function.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.families, public.adults, public.children, public.devices,
  public.device_profiles, public.settings, public.uploads, public.snapshots,
  public.manifests, public.consents to authenticated;
grant insert, update, delete on public.children to authenticated;
grant update (name) on public.devices to authenticated;

create policy family_read on public.families for select to authenticated
  using (id = public.my_family());

create policy adults_read on public.adults for select to authenticated
  using (family_id = public.my_family());

create policy children_read on public.children for select to authenticated
  using (family_id = public.my_family());
create policy children_write on public.children for insert to authenticated
  with check (family_id = public.my_family() and public.my_role() in ('owner', 'caregiver'));
create policy children_update on public.children for update to authenticated
  using (family_id = public.my_family() and public.my_role() in ('owner', 'caregiver'))
  with check (family_id = public.my_family());
create policy children_delete on public.children for delete to authenticated
  using (family_id = public.my_family() and public.my_role() = 'owner');

create policy devices_read on public.devices for select to authenticated
  using (family_id = public.my_family());
create policy devices_rename on public.devices for update to authenticated
  using (family_id = public.my_family() and public.my_role() in ('owner', 'caregiver'))
  with check (family_id = public.my_family());

create policy device_profiles_read on public.device_profiles for select to authenticated
  using (exists (select 1 from public.devices d where d.id = dev and d.family_id = public.my_family()));

create policy settings_read on public.settings for select to authenticated
  using (exists (select 1 from public.children c where c.id = child_id and c.family_id = public.my_family()));

create policy uploads_read on public.uploads for select to authenticated
  using (family_id = public.my_family());

create policy snapshots_read on public.snapshots for select to authenticated
  using (exists (select 1 from public.children c where c.id = child_id and c.family_id = public.my_family()));

create policy manifests_read on public.manifests for select to authenticated using (true);

create policy consents_read on public.consents for select to authenticated
  using (family_id = public.my_family());

-- ---------------------------------------------------------------- file storage

-- One private bucket for event batches, snapshots and manifests. Only the
-- /v1 function (service role) reads and writes it.
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public) values ('family', 'family', false)
    on conflict (id) do nothing;
  end if;
end $$;
