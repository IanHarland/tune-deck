# CLAUDE.md — notes for AI agents working on Tune Deck

## What this is

**Tune Deck** is a web app for jazz musicians at a session: you flick through a
deck of cards and it picks a random jazz standard for you, filtered by feel and
by obscurity/difficulty. After a tune is picked you can randomize the key, rate
how obscure/hard it felt (crowd-sourced scores improve over time), and open the
chart in iReal Pro via a deep link.

iOS/Android is a likely future path — the architecture is built so the backend
and business logic carry over and only the UI gets rebuilt natively.

Product spec lives in [jazz_standard_picker_handoff.md](jazz_standard_picker_handoff.md).
We diverge from it on stack (see below) per the owner's preference.

## Architecture — "API-first hybrid"

The guiding principle: **the UI is the only throwaway part when we go native.**
Backend, database, and core logic are written once and reused by a future Expo app.

- **Backend**: Flask + SQLAlchemy + Postgres, deployed on Fly.io. Mirrors the
  sibling `../Leif Bot` project's pattern (Dockerfile + gunicorn + idempotent
  migrations in `init_db()`, **no migration framework**). Exposes a JSON API only.
- **Frontend**: React + TypeScript + Vite SPA. The card-swipe deck. Built to
  static files that Flask serves.
- **Portable core** (`frontend/src/core/`): pure TS with **no DOM/React imports**
  — `types.ts`, `keys.ts`, `tunePicker.ts`, `irealLink.ts`, `api.ts`. These are
  meant to copy-paste into a future Expo app unchanged. Keep them framework-free.

### Going native later (the plan, not built yet)
New Expo/React Native app → reuses the Flask API + the `core/` TS modules →
only the visual + gesture layer is rewritten (`reanimated` / `gesture-handler`
instead of the web gesture lib). Don't put business logic in React components;
put it in `core/`.

## Layout

```
app/                 # Flask backend (Leif Bot pattern)
  web.py             # all routes: JSON API + serves built frontend
  models.py          # SQLAlchemy: Tune, TuneRating
  db.py              # engine + init_db() (idempotent migrations + seed loader)
frontend/            # Vite + React + TS SPA
  src/core/          # PORTABLE, framework-free TS (reused by future Expo app)
  src/components/    # React components (deck, cards, filters, sliders)
scripts/             # data pipeline + one-offs
  build_seed.mjs     # parse iReal backup -> data/tunes.json
data/
  tunes.json         # generated seed (committed)
Dockerfile           # multi-stage: build Vite -> serve via Flask/gunicorn
fly.toml
requirements.txt
```

## Data: where tunes come from

Source of truth is the owner's **iReal Pro backup HTML export**
(`~/Downloads/iReal Pro Backup ...html`), NOT scraped from irealpro.com. It's
the owner's real library and already has composer + key + style per tune.

iReal Pro export format (after URL-decoding each `irealb://` href): songs are
joined by `===`; each song's fields are `=`-separated:
`title=composer==style=key==transpose=<obfuscated chord data>`.
Composer is stored **"Last First"** (e.g. `Coltrane John`) — we flip to
"First Last" (last whitespace token = first name, rest = surname; handles
`Van Heusen Jimmy` → `Jimmy Van Heusen`).

`scripts/build_seed.mjs` does the whole pipeline → `data/tunes.json`. Re-run it
when the backup updates. `db.py` loads `data/tunes.json` on init (upsert by a
stable natural key so re-seeding doesn't wipe crowd ratings).

### Style → feel mapping
The app has 5 feel buckets: `ballad`, `medium_swing`, `up`, `latin`, `waltz`.
iReal has ~90 style strings; we map jazz-relevant ones and **drop pure
pop/rock/country/disco/reggae/soul/funk/folk/hiphop**. The original iReal style
is preserved in `ireal_style`. Borderline styles get a primary `feel` +
`additional_feels` (e.g. Medium Up Swing → up + medium_swing).

**Waltz is detected systemically from the TIME SIGNATURE**, not the style label:
`build_seed.mjs` de-obfuscates iReal's scrambled chord blob (50-char-segment
swap, see `unscramble()`) to read the `T34` token; any 3/x tune is forced to
`feel: waltz` (and `time_signature` is stored). This fixes tunes iReal labels as
swing but are actually in 3 (Song for My Lady, Up Jumped Spring, …).

### Mode tags
Each tune has a `tags` array. `canon.mjs` BEGINNER (the most-called ~55) →
`beginner`; ADVANCED+VERY_HARD → `hard`. Drives the Beginner/Hard picking modes
(see `core/tunePicker.ts` `modeWeight`). `canon.MANUAL_TUNES` adds tunes not in
the iReal library (e.g. Firm Roots, for Smalls mode).

### Fake-book chart references + covers
`scripts/build_charts.py` parses `MASTERNX.PDF` (the "Fake Book Master Index" in
`~/Documents/Practice Stuff/real books/`) into `data/charts.json`, keyed by
normalized title → `[{book, page}]`. Book codes map to **actual titles** (read
off each PDF's cover) in `BOOK_NAMES`. Reference-only (book + printed page) — no
chart content stored/shipped. `build_seed.mjs` merges them onto each tune as
`charts`. ~898 of 1,678 tunes have a chart. Chart refs are **openable** via a
private, password-gated PDF reader — see "Fake-book reader" below.

Matching tune titles to the index is spelling-tolerant and symmetric across
`build_charts.py` (`norm_keys`) and `build_seed.mjs` (`chartKeys`): fold
diacritics, `&`→`and`, `St.`→`Saint`, article-aware, and emit BOTH a
kept-parenthetical and dropped-parenthetical key (so "Nancy (With The Laughing
Face)" matches the index's inline spelling, and subtitles the index omits still
match). Keep the two implementations identical (a cross-check test exists).

`scripts/build_covers.py` renders **page 1 (the front cover) of each book's PDF**
into `frontend/public/covers/<slug>.jpg` (small thumbnails, the owner's own
files). The UI shows the cover next to each chart ref. The frontend recomputes
the same `slug(book)` to find the image; a missing cover just hides via onError.

### Fake-book reader (private, password-gated)
Lets the owner open a chart to the tune's page in their own fake books — NOT
public chart content, but a personal authenticated view of PDFs they own
(`app/fakebooks.py`, `/api/fakebook/*` in `web.py`, frontend `FakebookProvider`
+ `FakebookViewer`). Design:
- The ~11 books the index references (~500 MB) are embedded in the image from a
  gitignored `books/` dir (`scripts/stage_books.sh` stages them from iCloud;
  Dockerfile `COPY books`). Empty dir → reader stays dark (each `available:false`).
- One shared password (`FAKEBOOK_PASSWORD` secret) → a year-long signed session
  cookie (`SECRET_KEY` signs it). `GET /api/fakebook/<slug>.pdf` is 401 without
  it and Range-capable, so pdf.js fetches only the viewed pages.
- Frontend uses `react-pdf` (canvas render, so jump-to-page works on iOS). Chart
  rows (search + main card, shared `ChartRef`) turn tappable only when the reader
  is configured AND the book is present — invisible to everyone else.
- `BOOKS` in `app/fakebooks.py` maps display name → file + printed→PDF page
  `offset` (`PDF_page = printed + offset`); calibrate per book (scans have no
  page labels). Override offsets WITHOUT a 500 MB rebuild via the
  `FAKEBOOK_OFFSETS` secret (JSON `{slug: offset}`, fast restart). `slug()`
  matches build_covers.py / `coverSlug`.

### Scores (obscurity / difficulty, 0–100)
Not present in iReal data. Seeded by `scripts/canon.mjs` (tiered repertoire built
from jam-call-frequency data + must-know lists + domain knowledge):
- **obscurity** is AGGRESSIVE and canon-driven: CORE=4, STANDARD=16, COMMON=34,
  and **everything not in the canon trends to 100** (`100 - 9·fakebooks - 3·playlists`,
  floor 60) — i.e. tunes that probably never get called. ~230 tunes are "canon"
  (<45); the rest is intentional deep-cut noise you only reach by sliding
  obscurity up. The home slider DEFAULTS to obscurity 10 (surface the canon).
- **difficulty**: VERY_EASY=10, EASY=26, default 50, ADVANCED=84, VERY_HARD=93.
- The seed is only a placeholder: the **first** user rating becomes the score
  outright (no blend with the build-time guess), and ratings average thereafter
  — see `app/scoring.py`. Re-seeding refreshes the displayed score for *unvoted*
  tunes only.

## "Open in iReal Pro"
Each tune stores its full single-song `irealb://` deep link (reconstructed from
the backup segment). The result card has an **Open in iReal Pro** button that
launches the app to that exact song. Opens in the **original** key — the key is
baked into the chart data, so transposing would mean rewriting all the chords
(out of scope). This is a deep-link to the user's own iReal Pro app, not us
rendering charts, so it stays clean for App Store review later.

## Conventions
- Backend: snake_case, SQLAlchemy 2.0 style. Schema changes = append an
  idempotent statement to the `migrations` list in `init_db()` (Leif Bot rule).
- Frontend: `camelCase`, function components + hooks. **No business logic in
  components** — it goes in `core/`.
- `feel` enum values are snake_case strings shared between backend and `core/`.
- Don't display copyrighted chart content (chords/melody/lyrics). Metadata only.

## Deploying (Fly.io) — don't deploy unless asked
Same workflow as Leif Bot. App auto-stops (scale-to-zero); Postgres is a
separate Fly app. Commit and let the owner say when to deploy.

## Status
Deployed to Fly **2026-06-06**: app `tune-deck` (https://tune-deck.fly.dev),
Postgres app `tune-deck-db` (attached, sets `DATABASE_URL`). 2 HA machines in
sjc, scale-to-zero. iOS is explicitly later.

Deploy: `fly deploy -a tune-deck` (don't deploy without the owner's go-ahead).
Note: both machines run `init_db()` on boot; the very first boot seeds Postgres,
later boots hit the idempotent "already exists" path. iOS is explicitly later.
