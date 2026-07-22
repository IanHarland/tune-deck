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
import unicodedata

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

# --------------------------------------------------------------------------- #
# Master-index corrections
#
# MASTERNX.PDF is a hand-typed third-party compilation, and it is not clean. Its
# errors are invisible in the app: a mis-typed title silently costs a tune its
# chart, and a mis-typed page silently opens somebody else's chart. Everything
# below was verified by rendering the printed page out of the book itself and
# reading the title off the scan — none of it is guessed. To find more, diff the
# index's titles against data/tunes.json and eyeball the near misses.
# --------------------------------------------------------------------------- #

# The index's spelling of a title vs. the iReal library's. Some are index typos
# ("What 15 This Thing Called Love" — an OCR'd "Is"), some are just a different
# but equally valid spelling ("Green Dolphin Street" / "On Green Dolphin
# Street"). Either way the ref never matched. Registered under BOTH spellings,
# so nothing that already matched can regress.
TITLE_ALIASES = {
    "All Or Nothing At Al": "All Or Nothing At All",
    "April Skids": "April Skies",
    "Bark for Barsdale": "Bark For Barksdale",
    "Berrie's Tune": "Bernie's Tune",
    "Bess You Is My Woman Now": "Bess You Is My Woman",
    "Bouncing With Bud": "Bouncin' With Bud",
    "Breeze And 1 (The)": "The Breeze And I",
    "But Not For He": "But Not For Me",
    "Cantelope Island": "Cantaloupe Island",
    "Chasin' The Train": "Chasin' The Trane",
    "Comrad Conrad": "Comrade Conrad",
    "Cottage For Salt (A)": "A Cottage For Sale",
    "Crepuscule With Nellis": "Crepuscule With Nellie",
    "Devil May Cape": "Devil May Care",
    "Do Nothin' Till You Hear From Me": "Do Nothin' Til You Hear From Me",
    "Do Nothing 'Til You Hear From Me": "Do Nothin' Til You Hear From Me",
    "Do Nothing Till You Hear From Me": "Do Nothin' Til You Hear From Me",
    "Eternal Triange": "Eternal Triangle",
    "Failing In Love With Love": "Falling In Love With Love",
    "Flower Is A Lonesome Thing (A)": "A Flower Is A Lovesome Thing",
    "Freddie The Freeloader": "Freddie Freeloader",
    "Freight Trane": "Freight Train",
    "Green Dolphin Street": "On Green Dolphin Street",
    "Hallelujah I Love Him (Her) So": "Hallelujah I Just Love Him So",
    "I Thought About Your": "I Thought About You",
    "I'm A Pool To Want You": "I'm A Fool To Want You",
    "I'm Gettin' Sentimental Over You": "I'm Getting Sentimental Over You",
    "I'm Old Fasihoned": "I'm Old Fashioned",
    "I've Got Rhythm": "I Got Rhythm",
    "I've Grown Accustomed To Your Face": "I've Grown Accustomed To Her Face",
    "If s All Right With Me": "It's All Right With Me",
    "Jeannie": "Jeannine",
    "Jumping With Symphony Sid": "Jumpin With Symphony Sid",
    "Kary's France": "Kary's Trance",
    "L'il Darlin'": "Li'l Darling",
    "Lady Be Good!": "Oh, Lady Be Good",
    "Let's Cook One": "Let's Cool One",
    "Li'l Darlin": "Li'l Darling",
    "Makin' Whoopee": "Making Whoopee",
    "Manha De Carneval": "Manha De Carnaval",
    "Mean You": "I Mean You",
    "Meditaton": "Meditation",
    "Minha Saudade": "Mimha Saudade",       # the library is the one misspelling it
    "Moten's Swing": "Moten Swing",
    "My Little Boat": "Little Boat",
    "Myako": "Miyako",
    "Nerfertiti": "Nefertiti",
    "Night In Tunesia(A)": "A Night In Tunisia",
    "Now Is The Time": "Now's The Time",
    "Olinoqui Valley": "Oliloqui Valley",   # the book prints it "Olinoqui Vally"
    "One Note Sambaa": "One Note Samba",
    "Pannonic": "Pannonica",
    "Petite Fleure": "Petit Fleur",
    "Ploinciana": "Poinciana",
    "Pragression": "Progression",
    "Relaxin' At Carmarillo": "Relaxin' At Camarillo",
    "Rhyth-A-Ning": "Rhythm-a-ning",
    "Saga Of Harrison Crabpeathers": "The Saga Of Harrison Crabfeathers",
    "Scotch 'N' Soda": "Scotch And Soda",
    "Sentimental jorney": "Sentimental Journey",
    "Sleeping Bee": "A Sleepin' Bee",
    "Slow Boat To China": "On A Slow Boat To China",
    "So Nice (Sumer Sumamba)": "So Nice (Summer Samba)",
    "Softly As A Morning Sunrise": "Softly, As In A Morning Sunrise",
    "Stars Fall On Alabama": "Stars Fell On Alabama",
    "Struttin' With Some Barbeque": "Struttin' With Some Barbecue",
    "Surrey With The Fringe On Top (The)": "The Surrey With The Fringe On The Top",
    "Swingin' Shepherd Blues": "The Swinging Shepherd Blues",
    "The Thin05 We Did Last Summer": "The Things We Did Last Summer",
    "There 15 No Greater Love": "There Is No Greater Love",
    "Til There Was You": "Till There Was You",
    "Tricrotism": "Tricotism",
    "Waltz For Derby": "Waltz For Debby",
    "What 15 This Thing Called Love": "What Is This Thing Called Love",
    "What A Diff'rence A Day Made": "What A Difference A Day Made",
    "Will I You Still Be Mine": "Will You Still Be Mine",
    "You G0 To My Head": "You Go To My Head",
}

# Wrong printed page — the reader would open a stranger's chart. Keyed by
# (index title, book code, page as indexed) so a re-typed index can't have a fix
# applied to the wrong row.
#   Real Book Vol. 2: one run through "P" where the typist dropped the leading
#   "2" — Perdido really is on 288, and 88 is Joanne Brackeen's "Evening In
#   Concert". (People Will Say We're In Love is a plain 272-for-292 slip.)
#   Real Book Vol. 1: the two appendix entries are swapped against the pages as
#   the book actually numbers them.
PAGE_FIXES = {
    ("Palo-Alto", "RealBk2", "82"): "282",
    ("Patterns", "RealBk2", "84"): "284",
    ("Pennies From Heaven", "RealBk2", "86"): "286",
    ("Penny Arcade", "RealBk2", "87"): "287",
    ("Perdido", "RealBk2", "88"): "288",
    ("Perdido Line", "RealBk2", "90"): "290",
    ("People Will Say We're In Love", "RealBk2", "272"): "292",
    ("Petite Fleure", "RealBk2", "93"): "293",
    ("Petits Machins", "RealBk2", "94"): "294",
    ("Pick Yourself Up", "RealBk2", "95"): "295",
    ("Phase Dance", "RealBk2", "96"): "296",
    ("Perfect Love Jamala", "Realbk1", "A9"): "A10",
    ("Plain Jane", "Realbk1", "A10"): "A9",
}

# Refs to a page that isn't in the book at all. The Colorado Cookbook's tunes
# stop at printed 279 (its index-by-style pages follow) and "Jeep's Blues" isn't
# in it anywhere — where the entry came from is anyone's guess.
DROPPED_REFS = {
    ("Jeeps Blues", "Colorado", "315"),
}


def _fold(s: str) -> str:
    # strip diacritics: "Manhã"/"Desafinado" fold to plain ASCII so accented
    # library titles match the index's un-accented spellings.
    return "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c))


def _base(t: str) -> str:
    # shared, spelling-tolerant folding applied to BOTH the index and the seed
    # lookup. Symmetry is what matters: the same transform on both sides always
    # converges, even where it's "wrong" (e.g. "Greene St. Caper" -> saint), and
    # it merges split index spellings ("St. Thomas" + "Saint Thomas").
    s = _fold(t.lower())
    s = s.replace("&", " and ")                 # "Bangles & Beads" == "...and Beads"
    s = re.sub(r"\bst\.?\s+", "saint ", s)      # "St."/"St " -> "Saint " (word-initial)
    return s


def _finalize(s: str) -> str:
    # article-aware, alnum-only. Converges the inversion forms: "The Nearness Of
    # You" == "Nearness Of You, The" == "Nearness Of You (The)". The \s+ / [,\s]+
    # boundaries keep words like "Anthropology"/"Theme" intact.
    s = re.sub(r"^(the|a|an)\s+", "", s)
    s = re.sub(r"[,\s]+(the|a|an)\s*$", "", s)  # "X, The" or "X The"
    return re.sub(r"[^a-z0-9]", "", s)


def norm_keys(t: str) -> list[str]:
    # Up to two lookup keys per title, MUST match build_seed.mjs chartKeys().
    # A parenthetical is ambiguous — it can be a subtitle the index omits
    # ("Someday My Prince Will Come (From Snow White)" -> index has just the
    # main title) OR the actual title spelled inline ("Nancy (With The Laughing
    # Face)" -> index "Nancy With The Laughing Face"). So we emit BOTH the
    # kept-words form and the dropped form and register the ref under each.
    b = _base(t)
    kept = _finalize(re.sub(r"[()]", " ", b))        # keep the parenthetical words
    dropped = _finalize(re.sub(r"\([^)]*\)", " ", b))  # drop the parenthetical
    out: list[str] = []
    for k in (kept, dropped):
        if k and k not in out:
            out.append(k)
    return out


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
    seen_entries: set[tuple[str, str, str]] = set()  # index rows as printed
    skipped = 0
    fixed_pages = dropped = aliased = 0
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
            seen_entries.add((title, book, page))
            if (title, book, page) in DROPPED_REFS:
                dropped += 1
                continue
            fix = PAGE_FIXES.get((title, book, page))
            if fix:
                page, fixed_pages = fix, fixed_pages + 1
            # register under every key variant (kept- and dropped-parenthetical,
            # for the index's spelling AND the library's) so a lookup from any
            # title form finds the ref; dedup per key.
            alias = TITLE_ALIASES.get(title)
            if alias:
                aliased += 1
            keys = norm_keys(title) + (norm_keys(alias) if alias else [])
            for key in dict.fromkeys(keys):
                if (key, book, page) in seen:
                    continue
                seen.add((key, book, page))
                charts.setdefault(key, []).append(
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
    print(f"Index corrections applied: {aliased} title aliases, "
          f"{fixed_pages} page fixes, {dropped} refs dropped.")
    indexed_titles = {t for t, _b, _p in seen_entries}
    unused = (
        [str(k) for k in PAGE_FIXES if k not in seen_entries]
        + [str(k) for k in DROPPED_REFS if k not in seen_entries]
        + [t for t in TITLE_ALIASES if t not in indexed_titles]
    )
    if unused:
        print(f"WARNING: {len(unused)} correction(s) matched no index entry "
              f"(did the index change?): {sorted(unused)}")
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
