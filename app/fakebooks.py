"""Private, password-gated fake-book access.

The app never ships copyrighted chart *content* publicly (see CLAUDE.md). This
is different: a personal, authenticated reader for PDFs the owner already owns,
so the deck can jump straight to a tune's chart. Gated behind one shared
password (FAKEBOOK_PASSWORD) carried in a signed, year-long session cookie.

The PDFs live in FAKEBOOKS_DIR — in the image the Dockerfile copies them to
/app/books; locally point FAKEBOOKS_DIR at the source folder (e.g. the iCloud
"real books" dir). Filenames match the `file` values below.
"""
from __future__ import annotations

import hmac
import io
import json
import os
import re
from pathlib import Path

from pypdf import PdfReader, PdfWriter

BOOKS_DIR = Path(os.environ.get(
    "FAKEBOOKS_DIR",
    str(Path(__file__).resolve().parent.parent / "books"),
))

# Display name (matches chart.book in the seed) -> source file + printed→PDF page
# offset. offset means PDF_page = printed_page + offset (scanned front matter
# shifts the numbering). Calibrated per book: 8 came from embedded PDF page
# labels (incl. New Real Book Vol. 3 → offset 10, cross-checked by rendering
# printed 1/55/423), the other 3 (RealBk1, NewReal1/2, which lack labels) were
# read off the scans against the index. `file` names mirror build_covers.py.
#
# `sections` covers books whose page numbering restarts with a letter prefix.
# Real Book Vol. 1 has a 13-page unnumbered appendix (Alfie, Kelo, Valse Hot, …)
# the master index cites as A1–A13; those sit at PDF 498–510, hence offset 497.
# Same rule as the base offset: PDF_page = number + offset for that section.
BOOKS: dict[str, dict] = {
    "The Real Book, Vol. 1":      {"file": "REALBK1.PDF",  "offset": 13,
                                   "sections": {"A": 497}},
    "The Real Book, Vol. 2":      {"file": "REALBK2.PDF",  "offset": 7},
    "The Real Book, Vol. 3":      {"file": "REALBK3.PDF",  "offset": 5},
    "The New Real Book, Vol. 1":  {"file": "NEWREAL1.PDF", "offset": 15},
    "The New Real Book, Vol. 2":  {"file": "NEWREAL2.PDF", "offset": 12},
    "The New Real Book, Vol. 3":  {"file": "NEWREAL3.PDF", "offset": 10},
    "Jazz Fakebook":              {"file": "JAZZFAKE.PDF", "offset": -1},
    "Jazz LTD":                   {"file": "JAZZLTD.PDF",  "offset": 7},
    "Library of Musicians' Jazz": {"file": "LIBRARY.PDF",  "offset": 4},
    "The Colorado Cookbook":      {"file": "COLOBK.PDF",   "offset": 3},
    "Bill Evans Fake Book":       {"file": "EVANSBK.PDF",  "offset": 3},
}


def slug(name: str) -> str:
    # MUST match build_covers.py slug() and the frontend coverSlug().
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", name.lower())).strip("-")


# Per-book page offsets can be overridden without rebuilding the 500 MB image:
# set FAKEBOOK_OFFSETS to a JSON map of slug -> offset (a Fly secret → fast
# restart). Lets the owner dial in calibration cheaply. Falls back to the
# baked-in `offset` above. A value can be a bare number (the main run of pages)
# or a map of section -> offset, where "" is the main run:
#   {"the-real-book-vol-1": {"": 13, "A": 497}}
def _offset_overrides() -> dict:
    try:
        return json.loads(os.environ.get("FAKEBOOK_OFFSETS") or "{}")
    except (ValueError, TypeError):
        return {}


def offsets_for(name: str, cfg: dict) -> dict[str, int]:
    """section -> page offset. "" is the main, plainly-numbered run of pages."""
    out = {"": cfg["offset"], **cfg.get("sections", {})}
    ov = _offset_overrides().get(slug(name))
    if isinstance(ov, (int, float)):
        out[""] = int(ov)
    elif isinstance(ov, dict):
        for sec, val in ov.items():
            if isinstance(val, (int, float)):
                out[str(sec).upper() if sec else ""] = int(val)
    return out


# A printed page ref is a number, optionally prefixed by a section letter —
# "288" or "A1" (Real Book Vol. 1's appendix). Anything else is not a page.
_PAGE_RE = re.compile(r"^([A-Za-z]?)([0-9]{1,4})$")


def parse_page(token: str | int) -> tuple[str, int] | None:
    m = _PAGE_RE.match(str(token).strip())
    return (m.group(1).upper(), int(m.group(2))) if m else None


def pdf_page_for(name: str, cfg: dict, token: str | int) -> int | None:
    """Physical PDF page for a printed page ref, or None if this book has no
    such page — an unknown section, or a page past the end of the scan (the
    master index has a few refs to pages that simply aren't in the book)."""
    parsed = parse_page(token)
    if not parsed:
        return None
    section, number = parsed
    offsets = offsets_for(name, cfg)
    if section not in offsets:
        return None
    page = number + offsets[section]
    return page if 1 <= page <= page_count(cfg) else None


# slug -> (display name, config), for the PDF route to resolve a request.
_BY_SLUG = {slug(name): (name, cfg) for name, cfg in BOOKS.items()}


def book_for_slug(s: str) -> tuple[str, dict] | None:
    return _BY_SLUG.get(s)


def book_path(cfg: dict) -> Path:
    return BOOKS_DIR / cfg["file"]


def password() -> str | None:
    return os.environ.get("FAKEBOOK_PASSWORD") or None


def check_password(candidate: str) -> bool:
    pw = password()
    if not pw or not candidate:
        return False
    return hmac.compare_digest(candidate, pw)


# A tune's page count is inferred from the master index: the gap to the next
# indexed tune in the same book. charts.json is the COMPLETE index (it still holds
# the pop/rock tunes dropped from the app), so a gap means the tune runs long, not
# a missing entry. Capped so a rare index hole / photo run can't export a whole
# section.
_CHARTS_PATH = Path(__file__).resolve().parent.parent / "data" / "charts.json"
SPAN_CAP = 4


def _load_book_pages() -> dict[tuple[str, str], list[int]]:
    """(book, section) -> the printed page numbers the index knows about."""
    try:
        charts = json.loads(_CHARTS_PATH.read_text())
    except (OSError, ValueError):
        return {}
    pages: dict[tuple[str, str], set[int]] = {}
    for refs in charts.values():
        for c in refs:
            parsed = parse_page(c.get("page", ""))
            if not parsed:
                continue
            section, number = parsed
            pages.setdefault((c["book"], section), set()).add(number)
    return {k: sorted(ps) for k, ps in pages.items()}


_BOOK_PRINTED_PAGES = _load_book_pages()


def span_for(book_name: str, token: str | int) -> int:
    """Pages the tune at printed page `token` occupies = gap to the next indexed
    tune in that book, clamped to [1, SPAN_CAP]. Sections are counted on their
    own — A1's neighbour is A2, not page 2."""
    parsed = parse_page(token)
    if not parsed:
        return 1
    section, number = parsed
    pages = _BOOK_PRINTED_PAGES.get((book_name, section))
    if not pages:
        return 1
    nxt = next((p for p in pages if p > number), None)
    if nxt is None:
        return 1
    return max(1, min(SPAN_CAP, nxt - number))


_PAGE_COUNTS: dict[str, int] = {}


def page_count(cfg: dict) -> int:
    """Physical pages in the scan (cached — reopening a 500 MB PDF isn't free)."""
    key = cfg["file"]
    if key not in _PAGE_COUNTS:
        try:
            _PAGE_COUNTS[key] = len(PdfReader(str(book_path(cfg))).pages)
        except (OSError, ValueError):
            return 0
    return _PAGE_COUNTS[key]


def extract_pages(cfg: dict, start_1based: int, count: int) -> bytes:
    """A small PDF of `count` physical pages starting at `start_1based` — one
    tune's chart, for handing to forScore etc."""
    reader = PdfReader(str(book_path(cfg)))
    n = len(reader.pages)
    start = max(0, min(n - 1, start_1based - 1))
    end = min(n, start + max(1, count))
    writer = PdfWriter()
    for i in range(start, end):
        writer.add_page(reader.pages[i])
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def meta() -> dict:
    """Per-book slug + page offsets + availability so the client can build open
    links (and hide books whose PDF isn't uploaded, or refs whose page section
    this book doesn't have). `configured` is whether a password is set at all —
    if not, the feature stays dark."""
    books = {
        name: {
            "slug": slug(name),
            "offsets": offsets_for(name, cfg),
            "available": book_path(cfg).exists(),
        }
        for name, cfg in BOOKS.items()
    }
    return {"configured": password() is not None, "books": books}
