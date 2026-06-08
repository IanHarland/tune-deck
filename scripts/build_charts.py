"""build_charts.py — parse MASTERNX.PDF (the master fake-book index) into
data/charts.json: a map of normalized tune title -> list of {book, page}.

These are reference-only (which book + printed page a chart is on). No chart
content is stored or shipped — just "this tune is in Real Book 1 on p.13". The
seed builder (build_seed.mjs) merges this onto each tune.

Usage: python scripts/build_charts.py [path-to-MASTERNX.PDF]
Requires: pip install pypdf
"""
from __future__ import annotations

import json
import os
import re
import sys

from pypdf import PdfReader

DEFAULT_INDEX = os.path.expanduser(
    "~/Documents/Practice Stuff/real books/MASTERNX.PDF"
)
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "charts.json")

# index book code -> ACTUAL published book title (verified against the canonical
# Fake Book Master Index, archive.org/details/MASTERNX).
BOOK_NAMES = {
    "Realbk1": "The Real Book, Vol. 1",
    "RealBk1": "The Real Book, Vol. 1",
    "RealBk2": "The Real Book, Vol. 2",
    "RealBk3": "The Real Book, Vol. 3",
    "NewReal1": "The New Real Book, Vol. 1",
    "NewReal2": "The New Real Book, Vol. 2",
    "NewReal3": "The New Real Book, Vol. 3",
    "JazzFake": "Jazz Fakebook",
    "JazzLTD": "Jazz LTD",
    "Library": "Library of Musicians' Jazz",
    "Colorado": "The Colorado Cookbook",
    "EvansBk": "Bill Evans Fake Book",
}
KNOWN = sorted(BOOK_NAMES, key=len, reverse=True)  # longest-first for suffix match


def norm(t: str) -> str:
    # Must match build_seed.mjs chartKey() exactly. Article-aware so the three
    # inversion forms converge: "The Nearness Of You" == "Nearness Of You, The"
    # == "Nearness Of You (The)". The \s+ / [,\s]+ boundaries keep words like
    # "Anthropology"/"Theme" intact.
    s = t.lower()
    s = re.sub(r"\([^)]*\)", " ", s)            # drop parentheticals incl. "(The)"
    s = re.sub(r"^(the|a|an)\s+", "", s)
    s = re.sub(r"[,\s]+(the|a|an)\s*$", "", s)  # "X, The" or "X The"
    return re.sub(r"[^a-z0-9]", "", s)


def parse_line(line: str):
    """Return (title, book_code, page) or None. Handles glued tokens like
    'Swing)NewReal2' that the PDF text extraction occasionally produces."""
    toks = line.split()
    if len(toks) < 3:
        return None
    page = toks[-1]
    if not re.fullmatch(r"[A-Za-z]?\d+", page):
        return None
    btok = toks[-2]
    if btok in BOOK_NAMES:
        book = btok
        title = " ".join(toks[:-2])
    else:
        # try a known book code as a suffix of the glued token
        book = next((k for k in KNOWN if btok.endswith(k)), None)
        if not book:
            return None
        glued_prefix = btok[: -len(book)]
        title = " ".join(toks[:-2] + ([glued_prefix] if glued_prefix else []))
    title = title.strip()
    return (title, book, page) if title else None


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_INDEX
    reader = PdfReader(path)

    charts: dict[str, list[dict]] = {}
    seen: set[tuple[str, str, str]] = set()
    skipped = 0
    for pg in reader.pages:
        for line in (pg.extract_text() or "").splitlines():
            line = line.strip()
            if not line or line in ("Song Title Book Page", "Master Index"):
                continue
            parsed = parse_line(line)
            if not parsed:
                skipped += 1
                continue
            title, book, page = parsed
            key = (norm(title), book, page)
            if key in seen:
                continue
            seen.add(key)
            charts.setdefault(norm(title), []).append(
                {"book": BOOK_NAMES[book], "page": page}
            )

    # stable order within each tune
    for refs in charts.values():
        refs.sort(key=lambda r: (r["book"], r["page"]))

    out_path = os.path.normpath(OUT)
    with open(out_path, "w") as f:
        json.dump(charts, f, indent=0, sort_keys=True)

    total = sum(len(v) for v in charts.values())
    print(f"Parsed {total} chart refs for {len(charts)} titles "
          f"(skipped {skipped} non-entry lines).")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
