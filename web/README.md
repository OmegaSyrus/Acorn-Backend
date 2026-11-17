# Parent web app

Plain HTML and JavaScript, no build step (parent app plan v2, thread 5).

- `index.html` + `app.js`: sign in (Google, or an emailed link or 6-digit
  code), make the family, add and edit children, add a tablet with its
  pairing code (or the QR link `#pair/<code>`), rename or remove tablets,
  each child's play records, download everything, delete the family.
  Parents never move a child through the game: no level or world controls.
- `tablet.html` + `tablet.js`: a test tablet that stands in for the game's
  Family screen until the sync add-on exists: shows a pairing code and QR,
  links a player to each child, sends made-up play lines.
- `config.js`: the Supabase address, its publishable key (public) and the
  /v1 base. Point it at production when that project exists.

Hosted on GitHub Pages from the repository root (`.nojekyll` there), at
`https://omegasyrus.github.io/Acorn-Backend/web/`. Play records come from
`GET /v1/children/{child}/games/{game}/records`; skill names from
`../contract/skills.json`.

Supabase settings it needs (Auth, URL configuration): Site URL
`https://omegasyrus.github.io/Acorn-Backend/web/` and the same address with
`**` in Redirect URLs. Google Cloud OAuth client: authorised redirect URI
`https://<ref>.supabase.co/auth/v1/callback`. Function secret
`ACORN_PAIR_URL=https://omegasyrus.github.io/Acorn-Backend/web/#pair` so
the tablet's QR opens this page. The email templates may show
`{{ .Token }}` so a parent can type the code on another device.

Local run: `python3 -m http.server 8000` in the repository root, then
http://localhost:8000/web/ (add `http://localhost:8000/**` to Redirect URLs).
