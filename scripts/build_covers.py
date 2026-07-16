"""build_covers.py — render each fake book's FRONT COVER (page 1 of the PDF the
owner already has) into frontend/public/covers/<slug>.jpg.

Small thumbnails of book covers — low copyright risk, sourced from the owner's
own files. The slug is derived from the book's display name (see slug()), and
the frontend builds the same slug to find the image.

Usage: python scripts/build_covers.py [books-dir]
Requires: pip install pymupdf
"""
from __future__ import annotations

import os
import re
import sys

import fitz  # PyMuPDF

DEFAULT_DIR = os.path.expanduser("~/Documents/Practice Stuff/real books")
OUT_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "frontend", "public", "covers")
)
THUMB_WIDTH = 260  # px

# PDF file -> display name (must match build_charts.py BOOK_NAMES values).
FILE_TO_BOOK = {
    "REALBK1.PDF": "The Real Book, Vol. 1",
    "REALBK2.PDF": "The Real Book, Vol. 2",
    "REALBK3.PDF": "The Real Book, Vol. 3",
    "NEWREAL1.PDF": "The New Real Book, Vol. 1",
    "NEWREAL2.PDF": "The New Real Book, Vol. 2",
    "NEWREAL3.PDF": "The New Real Book, Vol. 3",
    "JAZZFAKE.PDF": "Jazz Fakebook",
    "JAZZLTD.PDF": "Jazz LTD",
    "LIBRARY.PDF": "Library of Musicians' Jazz",
    "COLOBK.PDF": "The Colorado Cookbook",
    "EVANSBK.PDF": "Bill Evans Fake Book",
}


def slug(name: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", name.lower())).strip("-")


def main() -> None:
    books_dir = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_DIR
    os.makedirs(OUT_DIR, exist_ok=True)
    for fname, book in FILE_TO_BOOK.items():
        path = os.path.join(books_dir, fname)
        if not os.path.exists(path):
            print(f"  skip (missing): {fname}")
            continue
        doc = fitz.open(path)
        page = doc[0]
        scale = THUMB_WIDTH / page.rect.width
        pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
        out = os.path.join(OUT_DIR, f"{slug(book)}.jpg")
        with open(out, "wb") as fh:
            fh.write(pix.tobytes(output="jpg", jpg_quality=82))
        print(f"  {book}  ->  {os.path.basename(out)} "
              f"({pix.width}x{pix.height}, {os.path.getsize(out)//1024}KB)")
    print(f"Wrote covers to {OUT_DIR}")


if __name__ == "__main__":
    main()
