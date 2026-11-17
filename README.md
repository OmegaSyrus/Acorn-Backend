# Acorn Backend

The shared family backend for the Acorn games: parent sign-in, families,
children, devices, pairing, play records, saves and settings. One backend
serves every game; each game is its own app with one family login.
Built on Supabase (approved by Terrence, 2026-11-16/17): Auth for parents
(email link and Google first), Postgres with row-level security, Storage for
event batches and snapshots, and one Edge Function as our own `/v1` API.

| Folder | What |
| --- | --- |
| `contract/` | The data contract every game, this backend and the parent app share: schemas, samples, skill list, API, retention. Source of truth |
| `supabase/migrations/` | Database tables and row-level security |
| `supabase/functions/api/` | The `/v1` API (one Edge Function); handlers in `supabase/functions/_shared/api.ts` |
| `tests/` | SQL tests for row-level security, API tests against a real Postgres |
| `tools/` | Contract sample checker, generator for the function's copy of the schemas |
| `docs/deploy.md` | Setting up staging and production |

Coming in later threads: `web/` (the parent app) and `godot-addon/` (the
sync add-on each game copies in).

## What it does today

- A parent signs in, accepts the consent text, and gets a family.
- Children: nickname, optional birth year, a picture from the game's set.
- A tablet pairs with a code (or QR) that a signed-in parent approves; it
  gets its own token and never signs in. Removing it makes its token "gone".
- Each tablet says which of its "Who is playing?" profiles is which child.
- Play log batches upload by device and sequence range (sent twice is
  harmless), checked against the contract, stored compressed.
- Save snapshots per child per game per device; settings per child per game,
  checked against the game's published manifest, latest change wins.
- Export everything as JSON; delete a child or the whole family, storage
  included; retention deletes event batches 24 months after a child's last
  play and idle families after a warning.
- No remote Level or world unlock: parents don't move children through a game.

## Running the tests

Needs Postgres 15+ and Deno 2.

```sh
python3 -I tools/check_contract.py                     # contract samples
deno task check                                        # types + generated contract
createdb rls && for f in tests/sql/supabase_shim.sql supabase/migrations/*.sql tests/sql/rls_test.sql; do
  psql -d rls -v ON_ERROR_STOP=1 -q -f "$f"; done       # row-level security
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432 deno task test   # API
```

The API tests make a fresh database per test from `tests/sql/supabase_shim.sql`
(the bits of Supabase the migrations expect) and every migration.

After changing anything in `contract/schemas/`, run `deno task contract` and
copy `contract/` into each game (Acorn Mathematics keeps it at `docs/contract/`).
