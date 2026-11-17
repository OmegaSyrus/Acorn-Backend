// Where the parent web app finds the backend. These are public values: the
// publishable key only lets a browser sign in; row-level security and the
// /v1 API decide what a signed-in parent can read. Never put a secret here.
export const CONFIG = {
  supabaseUrl: "https://maphrtpqbqmjfmhgqonq.supabase.co",
  supabaseKey: "sb_publishable_4ad59E_CypNBdlytVjAu8Q_GqN_pDMg",
  api: "https://maphrtpqbqmjfmhgqonq.supabase.co/functions/v1/api/v1",
  consentVersion: "2026-11-v1",
  game: "acorn-math",
  staging: true,
};
