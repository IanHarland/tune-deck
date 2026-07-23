"""Cross-implementation parity.

Several pieces of logic exist TWICE, in two languages, and must stay in step.
CLAUDE.md flags each of these; the failure mode is always silent:

  * slug()      — app/fakebooks.py, scripts/build_covers.py, core/covers.ts.
                  Drift = a cover that never loads, or a chart URL that 404s.
  * parse_page  — app/fakebooks.py vs core/fakebooks.ts parsePageRef.
                  Drift = a row that looks tappable and isn't, or vice versa.
  * norm_keys   — scripts/build_charts.py vs build_seed.mjs chartKeys.
                  Drift = a tune silently loses its chart.
  * key spelling — app/web.py, app/notation.py, core/keys.ts.
                  Drift = a key pill that engraves as a different key.

Each test drives the JS/Python side as a subprocess so it is the REAL
implementation being compared, not a transcription of it into the test.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from app import fakebooks, notation

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
requires_node = pytest.mark.skipif(NODE is None, reason="node not installed")


def run_node(script: str) -> str:
    return subprocess.run([NODE, "--input-type=module", "-e", script],
                          capture_output=True, text=True, cwd=ROOT,
                          check=True).stdout.strip()


# --------------------------------------------------------------------------- #
# slug() — three implementations
# --------------------------------------------------------------------------- #
NAMES = [
    "The Real Book, Vol. 1",
    "The New Real Book, Vol. 3",
    "Library of Musicians' Jazz",
    "Jazz LTD",
    "Bill Evans Fake Book",
    "The Colorado Cookbook",
]


def test_slug_matches_build_covers():
    """build_covers.py names the rendered thumbnails; fakebooks.py names the
    URLs. A mismatch means covers stop loading."""
    sys.path.insert(0, str(ROOT / "scripts"))
    try:
        import build_covers
    finally:
        sys.path.pop(0)
    for name in NAMES:
        assert build_covers.slug(name) == fakebooks.slug(name), name


@requires_node
def test_slug_matches_frontend_cover_slug():
    """core/covers.ts recomputes the slug client-side to find the image."""
    out = run_node(f"""
      const names = {json.dumps(NAMES)};
      const coverSlug = (book) => book.toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      console.log(JSON.stringify(names.map(coverSlug)));
    """)
    assert json.loads(out) == [fakebooks.slug(n) for n in NAMES]


def test_frontend_cover_slug_source_is_unchanged():
    """Guards the test above: if covers.ts is edited, the inline copy of the
    implementation must be updated too."""
    src = (ROOT / "frontend/src/core/covers.ts").read_text()
    assert '.replace(/[^a-z0-9]+/g, "-")' in src
    assert '.replace(/^-+|-+$/g, "")' in src


# --------------------------------------------------------------------------- #
# parse_page vs parsePageRef
# --------------------------------------------------------------------------- #
PAGE_TOKENS = ["288", "1", "A1", "A13", "a7", "  42  ", "", "xyz",
               "12345", "A", "1A", "-1", "p12"]


@requires_node
def test_parse_page_matches_the_frontend():
    ts = (ROOT / "frontend/src/core/fakebooks.ts").read_text()
    m = re.search(r"const m = (/\^.*?/)\.exec", ts)
    assert m, "parsePageRef's regex moved — update this test"
    out = run_node(f"""
      const tokens = {json.dumps(PAGE_TOKENS)};
      const parsePageRef = (page) => {{
        const m = {m.group(1)}.exec(String(page).trim());
        return m ? {{ section: m[1].toUpperCase(), number: parseInt(m[2], 10) }} : null;
      }};
      console.log(JSON.stringify(tokens.map(t => {{
        const p = parsePageRef(t);
        return p ? [p.section, p.number] : null;
      }})));
    """)
    js = json.loads(out)
    py = [list(fakebooks.parse_page(t)) if fakebooks.parse_page(t) else None
          for t in PAGE_TOKENS]
    assert js == py


# --------------------------------------------------------------------------- #
# Chart title normalisation — build_charts.py vs build_seed.mjs
# --------------------------------------------------------------------------- #
TITLES = [
    "Autumn Leaves",
    "The Way You Look Tonight",
    "Way You Look Tonight, The",
    "Nancy (With The Laughing Face)",
    "Someday My Prince Will Come (From Snow White)",
    "St. Thomas",
    "St Thomas",
    "Green Dolphin Street",
    "Blue 'n' Boogie",
    "Bemsha Swing",
    "A Night in Tunisia",
    "'Round Midnight",
    "Take the 'A' Train",
    "Django & Co",
]


def _chart_keys_js_source() -> str:
    """The real chartKeys implementation, lifted verbatim out of build_seed.mjs.

    Importing the module isn't an option — it runs the whole seed pipeline on
    import. Extracting the source keeps this a test of the SHIPPING code rather
    than of a copy that can rot."""
    src = (ROOT / "scripts" / "build_seed.mjs").read_text()
    m = re.search(
        r"const foldDiacritics =.*?const chartKeys = \(t\) => \{.*?\n\};",
        src, re.S)
    assert m, "chartKeys' declarations moved in build_seed.mjs — update this test"
    return m.group(0)


@requires_node
def test_chart_keys_match_between_the_two_pipelines(tmp_path):
    """build_charts.py builds the index; build_seed.mjs looks tunes up in it.
    If these diverge, a tune silently loses its chart — nothing on screen says
    why. This normalisation is worth ~80 refs and 30 tunes (CLAUDE.md)."""
    sys.path.insert(0, str(ROOT / "scripts"))
    try:
        import build_charts
    finally:
        sys.path.pop(0)

    mod = tmp_path / "chartkeys.mjs"
    mod.write_text(
        _chart_keys_js_source()
        + f"\nconsole.log(JSON.stringify({json.dumps(TITLES)}.map(chartKeys)));\n"
    )
    js = json.loads(subprocess.run([NODE, str(mod)], capture_output=True,
                                   text=True, check=True).stdout)
    py = [build_charts.norm_keys(t) for t in TITLES]
    assert js == py, "\n".join(
        f"{t!r}: js={j} py={p}" for t, j, p in zip(TITLES, js, py) if j != p)


# --------------------------------------------------------------------------- #
# Key spellings — three copies
# --------------------------------------------------------------------------- #
MAJOR = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
MINOR = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"]


def test_notation_key_spellings():
    assert notation.keys_for("C") == MAJOR
    assert notation.keys_for("G-") == MINOR


def test_web_key_spellings_match_notation():
    """web.py randomizes the key; notation.py offers the transposition pills.
    A tune randomized to "Db-" that notation spells "C#-" would break the link
    between what the card says and what the sheet engraves."""
    from app import web

    assert list(web.MAJOR_KEYS) == MAJOR
    assert list(web.MINOR_KEYS) == MINOR


def test_frontend_key_spellings_match():
    """core/keys.ts is the client-side mirror of the same tables."""
    src = (ROOT / "frontend/src/core/keys.ts").read_text()

    def table(name):
        m = re.search(rf"export const {name} = \[(.*?)\]", src, re.S)
        return re.findall(r'"([^"]+)"', m.group(1))

    assert table("MAJOR_KEYS") == MAJOR
    assert table("MINOR_KEYS") == MINOR


def test_minor_keys_avoid_flat_tonics_that_are_not_real_keys():
    """No "Db minor" — it's C# minor. Same for Gb/Ab minor."""
    assert "Db" not in MINOR and "Gb" not in MINOR and "Ab" not in MINOR


def test_every_book_in_the_seed_is_known_to_the_reader():
    """A chart ref naming a book fakebooks.py doesn't have would render a row
    the user can never open."""
    charts = json.loads((ROOT / "data" / "charts.json").read_text())
    referenced = {c["book"] for refs in charts.values() for c in refs}
    assert referenced <= set(fakebooks.BOOKS), referenced - set(fakebooks.BOOKS)
