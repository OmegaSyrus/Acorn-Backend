-- Row-level security: an adult sees only their own family; anon sees nothing.
-- Run after the shim and migrations: psql -v ON_ERROR_STOP=1 -f tests/sql/rls_test.sql
\set QUIET on
\o /dev/null
begin;
insert into auth.users values ('00000000-0000-4000-8000-00000000000a', 'a@example.invalid'),
                              ('00000000-0000-4000-8000-00000000000b', 'b@example.invalid'),
                              ('00000000-0000-4000-8000-00000000000c', 'c@example.invalid');
insert into families (id) values ('10000000-0000-4000-8000-00000000000a'), ('10000000-0000-4000-8000-00000000000b');
insert into adults values ('00000000-0000-4000-8000-00000000000a', '10000000-0000-4000-8000-00000000000a', 'owner'),
                          ('00000000-0000-4000-8000-00000000000b', '10000000-0000-4000-8000-00000000000b', 'owner'),
                          ('00000000-0000-4000-8000-00000000000c', '10000000-0000-4000-8000-00000000000a', 'viewer');
insert into children (id, family_id, nickname) values ('c_aaaaaaaaaaaa', '10000000-0000-4000-8000-00000000000a', 'Bear'),
                                                     ('c_bbbbbbbbbbbb', '10000000-0000-4000-8000-00000000000b', 'Wren');
insert into devices (id, family_id, game, name, token_hash) values
  ('d_aaaaaaaaaaaaaaaa', '10000000-0000-4000-8000-00000000000a', 'acorn-math', 'Kitchen', 'h1'),
  ('d_bbbbbbbbbbbbbbbb', '10000000-0000-4000-8000-00000000000b', 'acorn-math', 'Den', 'h2');
insert into settings values ('c_aaaaaaaaaaaa', 'acorn-math', 'daily_minutes', '30', 1, 1, 'parent'),
                            ('c_bbbbbbbbbbbb', 'acorn-math', 'daily_minutes', '45', 1, 1, 'parent');

create function pg_temp.expect(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then raise exception 'RLS test failed: %', what; end if;
end $$;

-- adult A
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a"}', true);
select pg_temp.expect((select count(*) from children) = 1, 'A sees one child');
select pg_temp.expect((select nickname from children) = 'Bear', 'A sees their own child');
select pg_temp.expect((select count(*) from devices) = 1, 'A sees one device');
select pg_temp.expect((select count(*) from settings) = 1, 'A sees their settings only');
select pg_temp.expect((select count(*) from families) = 1, 'A sees one family');
select pg_temp.expect((select count(*) from adults) = 2, 'A sees the adults of their family');
update children set nickname = 'Hacked' where id = 'c_bbbbbbbbbbbb';
insert into children (family_id, nickname) values ('10000000-0000-4000-8000-00000000000a', 'Moss');
select pg_temp.expect((select count(*) from children) = 2, 'A can add a child (id made by the database)');
update devices set name = 'Kitchen tablet' where id = 'd_aaaaaaaaaaaaaaaa';
select pg_temp.expect((select name from devices) = 'Kitchen tablet', 'A can rename their device');
reset role;
select pg_temp.expect((select nickname from children where id = 'c_bbbbbbbbbbbb') = 'Wren', 'A cannot change B''s child');

-- A cannot add a child to B's family
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a"}', true);
do $$ begin
  insert into children (family_id, nickname) values ('10000000-0000-4000-8000-00000000000b', 'Sneaky');
  raise exception 'RLS test failed: insert into another family was allowed';
exception when insufficient_privilege then null;
end $$;
-- A cannot read the device token column through a write either
do $$ begin
  update devices set token_hash = 'x' where id = 'd_aaaaaaaaaaaaaaaa';
  raise exception 'RLS test failed: token_hash was writable';
exception when insufficient_privilege then null;
end $$;
-- pairing requests are never readable
do $$ begin
  perform 1 from pair_requests;
  raise exception 'RLS test failed: pair_requests readable';
exception when insufficient_privilege then null;
end $$;

-- viewer C: reads, cannot write children
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000c"}', true);
select pg_temp.expect((select count(*) from children) = 2, 'viewer reads the family');
update children set nickname = 'Viewer' where id = 'c_aaaaaaaaaaaa';
reset role;
select pg_temp.expect((select nickname from children where id = 'c_aaaaaaaaaaaa') = 'Bear', 'viewer cannot rename');

-- anon
set local role anon;
do $$ begin
  perform 1 from children;
  raise exception 'RLS test failed: anon read children';
exception when insufficient_privilege then null;
end $$;
reset role;
rollback;
\o
\echo 'rls tests passed'
