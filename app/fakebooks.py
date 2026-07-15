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
import json
import os
import re
from pathlib import Path

BOOKS_DIR = Path(os.environ.get(
    "FAKEBOOKS_DIR",
    str(Path(__file__).resolve().parent.parent / "books"),
))

# Display name (matches chart.book in the seed) -> source file + printed→PDF page
# offset. offset means PDF_page = printed_page + offset (scanned front matter
# shifts the numbering); 0 = the PDF's page N is printed page N. Calibrate per
# book during setup. `file` names mirror build_covers.py FILE_TO_BOOK.
BOOKS: dict[str, dict] = {
    "The Real Book, Vol. 1":      {"file": "REALBK1.PDF",  "offset": 0},
    "The Real Book, Vol. 2":      {"file": "REALBK2.PDF",  "offset": 0},
    "The Real Book, Vol. 3":      {"file": "REALBK3.PDF",  "offset": 0},
    "The New Real Book, Vol. 1":  {"file": "NEWREAL1.PDF", "offset": 0},
    "The New Real Book, Vol. 2":  {"file": "NEWREAL2.PDF", "offset": 0},
    "The New Real Book, Vol. 3":  {"file": "NEWREAL3.PDF", "offset": 0},
    "Jazz Fakebook":              {"file": "JAZZFAKE.PDF", "offset": 0},
    "Jazz LTD":                   {"file": "JAZZLTD.PDF",  "offset": 0},
    "Library of Musicians' Jazz": {"file": "LIBRARY.PDF",  "offset": 0},
    "The Colorado Cookbook":      {"file": "COLOBK.PDF",   "offset": 0},
    "Bill Evans Fake Book":       {"file": "EVANSBK.PDF",  "offset": 0},
}


def slug(name: str) -> str:
    # MUST match build_covers.py slug() and the frontend coverSlug().
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", name.lower())).strip("-")


# Per-book page offsets can be overridden without rebuilding the 500 MB image:
# set FAKEBOOK_OFFSETS to a JSON map of slug -> offset (a Fly secret → fast
# restart). Lets the owner dial in calibration cheaply. Falls back to the
# baked-in `offset` above.
def _offset_overrides() -> dict:
    try:
        return json.loads(os.environ.get("FAKEBOOK_OFFSETS") or "{}")
    except (ValueError, TypeError):
        return {}


def offset_for(name: str, cfg: dict) -> int:
    ov = _offset_overrides().get(slug(name))
    return int(ov) if isinstance(ov, (int, float)) else cfg["offset"]


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


def meta() -> dict:
    """Per-book slug + page offset + availability so the client can build open
    links (and hide books whose PDF isn't uploaded). `configured` is whether a
    password is set at all — if not, the feature stays dark."""
    books = {
        name: {
            "slug": slug(name),
            "offset": offset_for(name, cfg),
            "available": book_path(cfg).exists(),
        }
        for name, cfg in BOOKS.items()
    }
    return {"configured": password() is not None, "books": books}
