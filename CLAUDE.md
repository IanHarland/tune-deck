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
`charts`. ~998 of 1,670 tunes have a chart. Chart refs are **openable** via a
private, password-gated PDF reader — see "Fake-book reader" below.

Matching tune titles to the index is spelling-tolerant and symmetric across
`build_charts.py` (`norm_keys`) and `build_seed.mjs` (`chartKeys`): fold
diacritics, `&`→`and`, `St.`→`Saint`, article-aware, and emit BOTH a
kept-parenthetical and dropped-parenthetical key (so "Nancy (With The Laughing
Face)" matches the index's inline spelling, and subtitles the index omits still
match). Keep the two implementations identical (a cross-check test exists).

**The master index is dirty, and its errors are invisible in the app** — a
mis-typed title silently costs a tune its chart, a mis-typed page silently opens
somebody else's. `build_charts.py` therefore carries three hand-verified fix
tables applied at parse time, every entry checked by rendering the printed page
out of the book and reading the title off the scan:
- `TITLE_ALIASES` — the index's spelling vs. the library's. Some are index typos
  (`What 15 This Thing Called Love` — an OCR'd "Is"), some are just a valid
  alternate (`Green Dolphin Street` / `On Green Dolphin Street`). Registered
  under BOTH spellings, so nothing that already matched can regress. This one
  table is worth ~80 refs and 30 tunes that had no chart at all.
- `PAGE_FIXES` — wrong printed page. Mostly one run through Real Book Vol. 2's
  "P" section where the typist dropped the leading "2" (Perdido is on 288, and
  88 is a different tune entirely), plus two swapped Vol. 1 appendix entries.
- `DROPPED_REFS` — refs to a page the book doesn't have.

The build warns if a fix no longer matches any index row. To find more, diff the
index's titles against `data/tunes.json` and eyeball the near misses — a bare
near-miss is NOT enough on its own ("Yesterday" and "Yesterdays" sit on adjacent
pages of Real Book Vol. 1 and are different tunes).

Coverage limit worth knowing: the index covers only the **11 old books** listed
in `BOOK_NAMES`, not the ~40 PDFs in the owner's folder. A tune absent from
`charts.json` may well be in a book we don't index (e.g. Ugly Beauty, which is in
none of the 11 but is in the Thelonious Monk Fake Book).

`scripts/build_covers.py` renders **page 1 (the front cover) of each book's PDF**
into `frontend/public/covers/<slug>.jpg` (small thumbnails, the owner's own
files). The UI shows the cover next to each chart ref. The frontend recomputes
the same `slug(book)` to find the image; a missing cover just hides via onError.

### Fake-book chart open (private, password-gated)
Lets the owner open a chart straight to the tune's page(s) in their own fake
books — NOT public chart content, but a personal authenticated PDF of pages they
own (`app/fakebooks.py`, `/api/fakebook/*` in `web.py`, frontend
`FakebookProvider` + `ChartRef`). Design:
- The ~11 books the index references (~500 MB) are embedded in the image from a
  gitignored `books/` dir (`scripts/stage_books.sh` stages them from iCloud;
  Dockerfile `COPY books`). Empty dir → charts stay dark (each `available:false`).
- One shared password (`FAKEBOOK_PASSWORD` secret) → a year-long signed session
  cookie (`SECRET_KEY` signs it). The tune-PDF route is 401 without it.
- **One tap = one action.** A chart row (search + main card, shared `ChartRef`)
  is tappable only when configured AND the book is present AND the page is one we
  can locate — invisible to everyone else. Tapping fetches just that tune's
  page(s) as a small PDF (`GET /api/fakebook/<slug>/tune-p<printed>.pdf`, pypdf
  `extract_pages`) and opens the blob as its own page so the OS PDF viewer's
  native Share button can "Copy to forScore". The row shows a spinner while
  fetching (cold extract from a 500 MB PDF is a few seconds), and a red `!` if the
  fetch failed. There is NO in-app full-book reader — we removed
  `FakebookViewer`/react-pdf (and its ~1.5 MB of bundle) deliberately.
- **Why open-as-a-page, not `navigator.share`:** forScore ships no share
  extension, so the Web Share sheet never lists it. Only a document-interaction
  share (the browser PDF viewer's own Share button, on a real file) offers "Copy
  to forScore". We hand over the already-fetched blob so the new view needs no
  re-auth. Known rough edge: forScore imports it under the blob's junk name (fix
  would be a signed tune URL with `Content-Disposition`).
- A tune's page COUNT is inferred from the master index: the gap to the next
  indexed tune in that book (`fakebooks.span_for`, from the complete charts.json,
  capped at SPAN_CAP=4) — so 2–3-page New Real Book arrangements come across
  whole. No OCR needed.
- **A printed page ref is not always a number.** It's `<optional section
  letter><number>` — Real Book Vol. 1 has a 13-page unnumbered appendix the index
  cites as A1–A13 (Alfie, Kelo, Reflections, Valse Hot, …). `parse_page` /
  `pdf_page_for` (server) and `parsePageRef` / `canOpenPage` (`core/fakebooks.ts`)
  handle both; keep them in step. Each section gets its own offset (A → 497, i.e.
  PDF 498–510) and its own `span_for` neighbour list.
- A page the book can't satisfy — unknown section, or past the end of the scan —
  **404s rather than clamping**. Clamping is how a bad index page number turns
  into quietly handing over the wrong chart.
- `BOOKS` in `app/fakebooks.py` maps display name → file + printed→PDF page
  `offset` (`PDF_page = printed + offset`) + optional per-section `sections`;
  calibrate per book (scans have no page labels). Override offsets WITHOUT a
  500 MB rebuild via the `FAKEBOOK_OFFSETS` secret (fast restart): JSON
  `{slug: offset}` or, for a book with sections, `{slug: {"": 13, "A": 497}}`.
  `slug()` matches build_covers.py / `coverSlug`. (`GET /api/fakebook/<slug>.pdf`,
  the Range-capable full-book route, still exists server-side but is no longer used
  by the UI.)
- **B♭/E♭ editions** (`BOOKS[...]["editions"]`, `?edition=Bb`): the instrument
  selector in the header now picks which *printing* a chart ref opens, so a horn
  player taps the same row and gets their transposition. This works **only
  because those printings are page-aligned with the concert edition** — the
  chart index is keyed to concert printed pages, so a differently-paginated
  edition would hand over a different tune entirely.
  - Verified aligned (two independent pages each, title read off the scan and
    cross-checked against charts.json): **Real Book Vol. 1** B♭ +9 / E♭ +10,
    **Vol. 2** B♭ +7 / E♭ +6, **Vol. 3** B♭ +8.
  - **Deliberately excluded: the New Real Book B♭ editions.** They're separately
    paginated and their offsets aren't even constant (NRB1 B♭ printed 113 = The
    Goodbye Look, which is printed 125 in concert; NRB3 B♭ printed 297 = Smile
    Please, printed 342 in concert). Adding them needs a B♭-specific index.
  - An edition inherits nothing from its parent — its own file and offset, and
    **no `sections`**, so Real Book Vol. 1's A1–A13 appendix resolves only in
    concert. An unstocked edition **404s rather than falling back**, and the UI
    shows a B♭/E♭ badge on the row only when it will really open transposed; no
    badge means concert pitch.
  - Offsets override via `FAKEBOOK_OFFSETS` under `"<slug>@Bb"` — a separate key
    from the concert book's, so it can't collide with the section-map shape.
  - Costs ~340 MB of image (books/ went 598 MB → 935 MB); the B♭ Real Book Vol. 1
    scan alone is 172 MB.

### Transposable notation (read any chart in any key)
Stores a chart as MusicXML so it can be read in any key (`app/notation.py`,
`core/notation.ts`, `NotationSheet`). Same password gate as the reader — it's
derived from the owner's own books.

**Charts are imported from a folder, not generated and not uploaded.** Drop a
MusicXML file in `charts/` and it becomes a transposable chart on the next
deploy. There is deliberately **no upload UI and no write API** — the folder is
the interface (`app/chart_import.py`, loaded idempotently from `init_db()`).

The workflow: open the chart in the app (it downloads as
`<Title> (<Book> p<Page>).pdf`) → scan that PDF in **Soundslice** → fix what the
scanner misread *in their editor* → export MusicXML → drop it in `charts/`. The
export keeps the base name, which is how the file finds its tune.
- Files are matched on the **`(<Book> p<Page>)` reference, not the title** — the
  reference is exact, whereas titles differ in spelling between index and
  library. Title only breaks a tie. Exporter decoration (a leading timestamp, a
  trailing `-1`) is stripped; a title with its own parens works because the
  LAST reference in the name wins.
- Imports land `verified=True` — the assumption is you corrected them in
  Soundslice.
- `charts/` is gitignored like `books/` (it holds copyrighted content) but is
  `COPY`d into the image. `python -m app.chart_import` checks the folder locally;
  a healthy re-run reports everything "unchanged".
- A file whose contents already match the stored row is skipped without
  re-vetting, so repeat boots are nearly free. A broken file is logged and
  skipped — never fatal, because this runs during startup.
- `GET /api/notation/tunes` (password-gated) lists which tunes have a chart, so
  "Read in any key" appears **only where it does something** — on the result
  card and in search. It used to be the control that STARTED a transcription, so
  it showed everywhere; now it only reads one.

- **Two automated paths were tried and both failed. Don't rebuild either
  without new evidence.**
  - *Classical OMR* (2026-07-22): `oemer` took ~4 min/page and got the key
    signature wrong (1 sharp for a 3-flat chart), no time signature, no chords,
    garbage pitches. Audiveris has **no chord-symbol support at all** (issue
    #243, open since 2019) — disqualifying for lead sheets. `books/*.PDF` are
    pure image scans (0 embedded text chars), so there's no text to shortcut to.
  - *Vision-model transcription* (2026-07-23, removed): got the chords right and
    roughly **half the melody**, at ~$1.30 and ~11 min per chart. Chords are ~30
    printed strings; a melody is ~400 notes that must each be right, and at 95%
    per-note accuracy that's still ~20 wrong notes a chart. Its failure mode was
    the dangerous one — plausible-looking notation that isn't the tune.
  - Soundslice's scanner is purpose-built ML and lands ~99%, but it has **no
    scanning API** (their data API only accepts MusicXML *uploads*), so the scan
    step is manual by necessity. At $5/mo for 100 pages that's ~5¢ a chart
    against $1.30, so manual is also the cheap option.
  - Flat/Opuscan *does* have an OMR API (~€0.33/page) if an automated path is
    ever wanted, but its export was measurably worse: on Autumn Leaves it
    dropped 8 of 33 bars and picked up parenthesised reharms as real changes.
- **Import once, transpose forever.** The MusicXML is stored in
  `tune_transcriptions` (unique per tune+book+page). Every key is a re-render of
  that one row. The client pins the import to the chart the panel displayed
  (`?book=&page=`) so the file can't attach to a page you never opened.
- **Verovio can SEGFAULT on MusicXML it dislikes** — a `<clef number="2">` on a
  one-staff part does it (Opuscan emits exactly that). In-process that kills the
  gunicorn worker, and with `-w 1` every in-flight request dies with it: the
  browser then waits forever on a response that never comes, which is what the
  endless "Engraving…" was. So:
  - `sanitize_musicxml()` strips clefs for staves the part doesn't declare, and
  - `check_renderable()` renders the file **in a child process, in all 12 keys**,
    before anything is stored. A crash there is an exit code, not an outage.
  - Anything in the DB has therefore already engraved cleanly in every key, so
    the in-process render path only ever sees input proven safe. Keep it that way.
  - The client also puts a 30 s deadline on the SVG fetch, so a hang shows an
    error rather than an eternal spinner.
- **Rendering is server-side, deliberately.** Verovio also ships as WASM, but
  it's several MB and we dropped react-pdf for being 1.5 MB while still
  supporting iPadOS 14 Safari. The bundle is unchanged; a warm render is ~70 ms.
- **The music font is served separately** (`/api/notation/font.css`, straight
  from the installed verovio package — not vendored, so it can't drift).
  Verovio otherwise inlines 58 KB of base64 WOFF2 into *every* SVG: 49 KB
  gzipped per key vs **4.4 KB** linked. Without that stylesheet in the document,
  chord-symbol accidentals render as tofu boxes.
- Two transposition paths, and they agree: Verovio's `transpose` option for the
  rendered SVG, and `notation.transpose_musicxml()` for the MusicXML export
  (Verovio can only export MEI). Both are cross-checked in testing.
- `verovio.toolkit().setOptions()` **merges** — an absent `transpose` must be
  cleared explicitly or the previous render's interval silently persists.
- `source_key` is derived from the file's own key signature plus the tune's
  mode, so a G-minor chart with a 2-flat signature stores `G-`, not `Bb`.

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
