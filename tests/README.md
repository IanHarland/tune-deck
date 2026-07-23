# Tests

```bash
scripts/test.sh            # both suites
scripts/test.sh py         # backend only (pytest)
scripts/test.sh js         # frontend only (vitest)
scripts/test.sh py -k slug # pass args through to pytest
```

First run needs the dev deps: `pip install -r requirements-dev.txt`
(pytest is deliberately kept out of `requirements.txt` — the Dockerfile
installs that one and pytest has no business in the production image).

## Layout

| Where | What |
|---|---|
| `tests/` | Backend (pytest) |
| `frontend/src/core/__tests__/` | Portable core (vitest) |

The frontend suite covers `src/core/` only — the framework-free layer a future
Expo app reuses verbatim. That's deliberate: it's where the business logic
lives, and it's the code that has to survive the UI being rewritten.

## What each file is defending

**`test_notation.py`** — key maths and MusicXML handling. The transposition
tests matter more than they look: two independent paths exist (Verovio's
`transpose` for the SVG, `transpose_musicxml` for the export) and they must
agree, or you get an SVG in one key and a download in another. Also pins the
segfault guards: `sanitize_musicxml` stripping clefs for undeclared staves, and
`check_renderable` running out-of-process.

**`test_fakebooks.py`** — the arithmetic that decides *which page of a 500-page
scan* gets handed over. An off-by-one silently returns somebody else's tune and
nothing downstream can tell, so these lean on the calibration facts recorded in
CLAUDE.md rather than just checking the code agrees with itself.

**`test_pdf_memory.py`** — regression for the 502. pypdf slurps the whole file
into memory when handed a *path*, so one chart out of the 180 MB B♭ Real Book
cost 208 MB of RSS and OOM-killed the machine. Pins both the mechanism (never a
path) and the outcome (memory flat as the book grows) — the bug is invisible on
a small file, so a correctness-only test would pass under the broken code.

**`test_chart_import.py`** — the `charts/` folder loader. Files match on the
`(<Book> p<Page>)` reference, not the title. Hard requirement: a bad file is
skipped and logged, never fatal, because this runs during boot.

**`test_scoring.py`** — two rules that are easy to confuse. Obscurity/difficulty:
the first real vote *replaces* the seed outright. Hipness: a Bayesian prior of
one neutral vote, so one swipe nudges to 75/25 instead of slamming the rail.

**`test_web.py`** — the API, focused on the privacy boundary (no chart content
in any public payload; every private route 401s without the cookie) and the
404-don't-guess rule.

**`test_db.py`** — seeding idempotency. `init_db()` runs on every boot on both
HA machines, so a re-seed must not duplicate tunes *or* clobber crowd ratings.

**`test_parity.py`** — the cross-language checks. Several pieces of logic exist
twice and CLAUDE.md flags each; the failure mode is always silent:

| Logic | Copies | Drift causes |
|---|---|---|
| `slug()` | fakebooks.py, build_covers.py, covers.ts | covers stop loading, chart URLs 404 |
| `parse_page` | fakebooks.py, fakebooks.ts | rows tappable that shouldn't be, or vice versa |
| `norm_keys` | build_charts.py, build_seed.mjs | a tune silently loses its chart |
| key spellings | web.py, notation.py, keys.ts | a key pill engraves a different key |

These drive the *real* implementation as a subprocess (Node for the JS side,
importing the actual script for Python) rather than re-stating it in the test,
so they can't pass against a copy that has rotted.

## Notes

- Tests never touch the real database or the book scans: `conftest.py` rewrites
  `DATABASE_URL`, `FAKEBOOKS_DIR` and `CHARTS_DIR` at import time, *before* any
  `app.*` module loads (those read env at module scope).
- The web fixture uses `StaticPool` — a bare `sqlite://` gives every connection
  its own empty database, so routes would never see fixture data.
- Node is optional. The parity tests skip cleanly without it.

## Known finding

`data/tunes.json` has one natural-key collision: `Someday (You'll Be Sorry)` and
`Someday You'll Be Sorry` — the same Louis Armstrong tune, entered twice in the
iReal library with different punctuation. It isn't harmful (the upsert merges
them into one row) but the parenthesised spelling wins and the other never
appears. Allowlisted in `test_db.py::KNOWN_SEED_COLLISIONS` so a *new* collision
still fails the suite.
