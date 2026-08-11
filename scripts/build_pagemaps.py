"""build_pagemaps.py — read every fake-book scan's own printed page numbers and
write data/pagemaps.json: file -> the printed→PDF page mapping the scan actually
has.

Why this exists
---------------
app/fakebooks.py used to assume one constant offset per book (PDF = printed +
offset). That holds only if the scan contains every page exactly once. It
doesn't. The New Real Book Vol. 1 scan is missing printed pages 3–4 and has 28–29
twice, so a constant offset hands over the wrong chart for most of the book —
"All The Things You Are" (printed 4) opened Airegin (printed 2).

A wrong page is worse than no page: it is silent. So instead of calibrating one
number per book by eye, we read the page number off every single page and build
an exact map. Pages the scan doesn't contain get no mapping and 404 at runtime,
which is the existing "never clamp" rule (app/fakebooks.py).

How
---
macOS's Vision framework OCRs the four corners of each page. Vision is good but
not perfect on isolated digits (it read a lone "6" as "9"), so no single reading
is trusted: candidates vote for an OFFSET, offsets are agreed by neighbourhood
consensus, and the map is built from runs of pages that agree. A page whose
number is smudged is carried by its neighbours.

Usage:
    .venv/bin/python scripts/build_pagemaps.py            # all books
    .venv/bin/python scripts/build_pagemaps.py NEWREAL1   # one, by file stem

Dev-only. Needs `pip install pymupdf pyobjc-framework-Vision` in the venv —
deliberately NOT in requirements.txt, since none of it ships in the Fly image.
Raw OCR is cached in data/.pagemap_ocr.json so reconstruction can be re-run
without paying for the scan again (delete it to force a re-read).
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

import fitz  # pymupdf
from PIL import Image

import Quartz
import Vision
from Foundation import NSData

ROOT = Path(__file__).resolve().parent.parent
BOOKS_DIR = Path(os.environ.get("FAKEBOOKS_DIR", ROOT / "books"))
OUT = ROOT / "data" / "pagemaps.json"
CACHE = ROOT / "data" / ".pagemap_ocr.json"

# Bands as (x0, y0, x1, y1) fractions of the page, read whole rather than by
# corner. Corners seemed obvious and were wrong: these books do not agree on
# where the folio goes. The Colorado Cookbook prints "Page 57" centred at the
# FOOT; the B♭ Real Book Vol. 1's is handwritten and sits ~14% down the page, far
# below any sane corner box. Cropping tight found nothing at all in three books.
#
# Reading the full band drags in every number printed near the top of a chart —
# chord extensions, bar numbers, "2." endings. That is fine, and cheaper than
# per-book calibration: junk numbers scatter, so they never form a run of pages
# whose numbering advances by exactly one, and the Viterbi below only believes
# runs. The real folio is the only thing in the band that behaves like a folio.
BANDS = [
    (0.0, 0.00, 1.0, 0.18),
    (0.0, 0.86, 1.0, 1.00),
]
DPI = 150
UPSCALE = 3          # Vision needs the glyph big; a raw 150dpi folio is too small
MAX_PAGE_NO = 600    # no book here numbers past this; anything larger is OCR noise


PAD = 80  # whitespace added around a crop; Vision misses glyphs flush to an edge


def ocr(im: Image.Image) -> list[tuple[str, float, float]]:
    """(text, x, y) per observation, x/y as fractions of `im` with y from the TOP.

    Vision reports boxes from the bottom-left; everything else here counts down
    from the top of the page, so flip once, at the source."""
    buf = io.BytesIO()
    im.save(buf, "PNG")
    png = buf.getvalue()
    data = NSData.dataWithBytes_length_(png, len(png))
    src = Quartz.CGImageSourceCreateWithData(data, None)
    cg = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
    if cg is None:
        return []
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setUsesLanguageCorrection_(False)  # folios are digits, not words
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, None)
    handler.performRequests_error_([req], None)
    out = []
    for obs in req.results() or []:
        cand = obs.topCandidates_(1)
        if not (cand and len(cand)):
            continue
        box = obs.boundingBox()
        cx = box.origin.x + box.size.width / 2
        cy = 1.0 - (box.origin.y + box.size.height / 2)
        out.append((cand[0].string(), cx, cy))
    return out


def page_candidates(page) -> list[list[float]]:
    """Every integer the head and foot of this page might be showing, as
    [number, x, y] with x/y as fractions of the PAGE (y from the top).

    The position is what separates a folio from prose. Reading a full-width band
    also reads numbered lists — the New Real Book Vol. 1's "General Rules" page
    is 18 numbered paragraphs, and items 1., 2., 3. on consecutive front-matter
    pages imitate a folio run well enough to drag the body's start onto them.
    A folio holds still in one spot on every page of the book; a list item does
    not. select_folios() below uses that."""
    pix = page.get_pixmap(dpi=DPI)
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("L")
    w, h = img.size
    found: list[list[float]] = []
    for fx0, fy0, fx1, fy1 in BANDS:
        x0, y0 = int(w * fx0), int(h * fy0)
        x1, y1 = int(w * fx1), int(h * fy1)
        crop = img.crop((x0, y0, x1, y1))
        cw, ch = crop.size
        crop = crop.resize((cw * UPSCALE, ch * UPSCALE), Image.LANCZOS)
        pad = Image.new("L", (crop.width + 2 * PAD, crop.height + 2 * PAD), 255)
        pad.paste(crop, (PAD, PAD))
        for text, cx, cy in ocr(pad):
            nums = re.findall(r"\d+", text)
            if not nums:
                continue
            # unwind pad -> upscale -> crop offset, back to a page fraction
            px = (cx * pad.width - PAD) / UPSCALE + x0
            py = (cy * pad.height - PAD) / UPSCALE + y0
            for tok in nums:
                n = int(tok)
                if 1 <= n <= MAX_PAGE_NO:
                    found.append([n, round(px / w, 4), round(py / h, 4)])
    return found


def scan_book(path: Path) -> list[list[int]]:
    doc = fitz.open(path)
    rows = []
    for i in range(doc.page_count):
        rows.append(page_candidates(doc[i]))
        if (i + 1) % 50 == 0:
            print(f"    {path.stem}: {i + 1}/{doc.page_count}", flush=True)
    doc.close()
    return rows


# --------------------------------------------------------------------------- #
# Reconstruction
#
# A scan is a sequence of pages whose offset (pdf_index - printed_number) is
# piecewise constant: it holds for a long run, then jumps where the scanner
# dropped or double-fed pages. Recovering those runs from noisy folio readings
# is a Viterbi problem — reward a page for agreeing with an offset, charge a
# fixed toll for changing offset, take the highest-scoring path.
#
# The toll is what makes it robust. A single misread folio can buy one page of
# reward but must pay the toll twice (in and out), so it always loses; a real
# two-page run pays the toll once more than its neighbour and wins. That is
# precisely the discrimination we need: NRB1's genuine two-page opening run
# (printed 1–2) survives, while every isolated 6-read-as-9 is rejected.
# --------------------------------------------------------------------------- #

SWITCH_COST = 1.0   # toll for changing offset between consecutive pages
MIN_SUPPORT = 2     # an offset must be read this often to be a candidate at all

# Folio-position grid. Coarse enough that a crooked scan's folio still lands in
# the same cell page to page, fine enough to separate a corner from body text.
GRID_X, GRID_Y = 16, 32
MIN_CELL_HITS = 5   # readings in a cell before we believe a folio lives there


def select_folios(rows: list[list[list[float]]]) -> list[list[int]]:
    """Keep only the numbers printed where THIS book prints its folio.

    Learned, not configured, because these books disagree: the Colorado Cookbook
    centres "Page 57" at the foot, the B♭ Real Book Vol. 1's is handwritten a
    seventh of the way down the page. So: find the offset that dominates the
    whole book (that many pages can only agree by being right), look at where
    those readings physically sit, and accept only readings in the same few
    grid cells.

    This is what keeps prose out. A numbered list in the front matter can fake a
    run of consecutive numbers, but it cannot fake sitting in the folio's corner
    on every page of the book — and it is one of those runs that put "All The
    Things You Are" back on Airegin's page.

    Falls back to the unfiltered readings if it can't find a confident position,
    since a filter that rejects everything is worse than no filter.
    """
    votes: Counter[int] = Counter()
    for i, cs in enumerate(rows):
        for n, _x, _y in cs:
            votes[i + 1 - int(n)] += 1
    if not votes:
        return [[int(n) for n, _x, _y in cs] for cs in rows]
    dominant, hits = votes.most_common(1)[0]
    if hits < 20:
        return [[int(n) for n, _x, _y in cs] for cs in rows]

    cells: Counter[tuple[int, int]] = Counter()
    for i, cs in enumerate(rows):
        for n, x, y in cs:
            if i + 1 - int(n) == dominant:
                cells[(min(int(x * GRID_X), GRID_X - 1),
                       min(int(y * GRID_Y), GRID_Y - 1))] += 1
    good = {c for c, k in cells.items() if k >= MIN_CELL_HITS}
    if not good:
        return [[int(n) for n, _x, _y in cs] for cs in rows]
    # widen by one cell so a crooked page or a stray descender still counts
    accepted = {(gx + dx, gy + dy) for gx, gy in good
                for dx in (-1, 0, 1) for dy in (-1, 0, 1)}

    out = []
    for cs in rows:
        keep = [int(n) for n, x, y in cs
                if (min(int(x * GRID_X), GRID_X - 1),
                    min(int(y * GRID_Y), GRID_Y - 1)) in accepted]
        out.append(keep)
    return out


def viterbi_offsets(cands: list[list[int]]) -> list[int]:
    """Most likely offset for every PDF page."""
    n = len(cands)
    seen: list[set[int]] = [{i + 1 - c for c in cs} for i, cs in enumerate(cands)]
    support: Counter[int] = Counter()
    for s in seen:
        support.update(s)
    states = sorted(o for o, c in support.items() if c >= MIN_SUPPORT)
    if not states:
        return [0] * n

    NEG = float("-inf")
    score = {o: 0.0 for o in states}
    back: list[dict[int, int]] = []
    for i in range(n):
        prev_best = max(score.values())
        prev_arg = max(score, key=lambda o: score[o])
        nxt, ptr = {}, {}
        for o in states:
            # stay in o, or pay the toll to arrive from the best other state
            stay = score[o]
            move = prev_best - SWITCH_COST if prev_arg != o else NEG
            # (prev_best is over all states incl. o; when o IS the argmax the
            # move option is meaningless, hence the guard)
            if move > stay:
                ptr[o], base = prev_arg, move
            else:
                ptr[o], base = o, stay
            nxt[o] = base + (1.0 if o in seen[i] else 0.0)
        score = nxt
        back.append(ptr)

    path = [max(score, key=lambda o: score[o])]
    for ptr in reversed(back[1:]):
        path.append(ptr[path[-1]])
    return list(reversed(path))


def runs_from(path: list[int], cands: list[list[int]]) -> list[tuple[int, int, int]]:
    """(pdf_start, pdf_end, offset) runs, each TRIMMED to the pages whose own
    folio confirmed that offset.

    Trimming is the safety rail. An unnumbered stretch — Real Book Vol. 1's
    A1–A13 appendix, plates, back matter — otherwise inherits the body's offset
    and silently claims printed numbers the book never printed, so a ref to a
    page past the end would open an appendix page instead of 404-ing. Interior
    gaps are still interpolated: a smudged folio between two confirmed ones is
    genuinely that page.
    """
    seen = [{i + 1 - c for c in cs} for i, cs in enumerate(cands)]
    raw: list[list[int]] = []
    for i, off in enumerate(path, start=1):
        if raw and raw[-1][2] == off and raw[-1][1] == i - 1:
            raw[-1][1] = i
        else:
            raw.append([i, i, off])
    out = []
    for start, end, off in raw:
        confirmed = [p for p in range(start, end + 1) if off in seen[p - 1]]
        if len(confirmed) < MIN_SUPPORT:
            continue
        out.append((confirmed[0], confirmed[-1], off))
    return out


def build_map(cands: list[list[int]]) -> dict:
    """printed→PDF segments for one scan: [[printed_start, printed_end, offset]].

    Only the book's body survives. Front matter is dropped by requiring the
    printed numbering to be non-decreasing across segments — a book's own
    alphabetical index (which is full of page numbers, and which OCR happily
    reads) lands before page 1 and jumps around, so it can never be part of the
    longest non-decreasing chain.
    """
    runs = runs_from(viterbi_offsets(cands), cands)
    segs = []
    for pdf_start, pdf_end, off in runs:
        if pdf_end - off < 1:
            continue  # ends before printed page 1: not body
        segs.append((max(1, pdf_start - off), pdf_end - off, off, pdf_end - pdf_start + 1))

    # longest non-decreasing chain by printed_start, weighted by pages covered
    n = len(segs)
    best = [s[3] for s in segs]
    prev = [-1] * n
    for i in range(n):
        for j in range(i):
            if segs[j][0] <= segs[i][0] and best[j] + segs[i][3] > best[i]:
                best[i], prev[i] = best[j] + segs[i][3], j
    keep: list[int] = []
    if n:
        i = max(range(n), key=lambda k: best[k])
        while i != -1:
            keep.append(i)
            i = prev[i]
        keep.reverse()
    chain = [[segs[i][0], segs[i][1], segs[i][2]] for i in keep]
    return {"segments": stitch(drop_impossible_overlaps(chain))}


# A scanner that double-feeds grabs a sheet or two, not sixty. An overlap bigger
# than this is not a re-feed, it's a misreading.
MAX_DOUBLE_FEED = 8


def drop_impossible_overlaps(chain: list[list[int]]) -> list[list[int]]:
    """Throw out short islands that contradict the run they sit inside.

    Vision confuses a handwritten 7 for a 1, and it does so CONSISTENTLY: three
    pages numbered 271–273 all read as 211–213, which is a perfectly self-
    consistent little run at its own offset. The tell isn't the readings, it's
    the geometry — those pages sit physically between printed 270 and 274, so
    they cannot be page 211. Real Book Vol. 1's A1–A13 appendix (whose pages
    print a bare 1–13) is caught the same way.

    Keeping them would mark ~35 real pages missing across four books AND leave
    segments claiming printed 211 lives at two different physical pages."""
    out: list[list[int]] = []
    for seg in chain:
        while out and out[-1][1] - seg[0] + 1 > MAX_DOUBLE_FEED:
            # genuinely incompatible: keep whichever run is better attested
            if (out[-1][1] - out[-1][0]) >= (seg[1] - seg[0]):
                seg = None
                break
            out.pop()
        if seg is not None:
            out.append(seg)
    return out


def stitch(chain: list[list[int]]) -> list[list[int]]:
    """Merge consecutive segments that share an offset, filling the gap.

    Same offset means the same printed→PDF line, so the pages in between can
    only be the printed pages in between — the folios there just weren't read
    (smudged, or misread as above). Merging is safe in a way that extending past
    the LAST confirmed page is not: this only ever interpolates between two
    confirmed runs, and an unnoticed insertion would have moved the offset."""
    out: list[list[int]] = []
    for seg in chain:
        if out and out[-1][2] == seg[2] and seg[1] > out[-1][1]:
            out[-1] = [out[-1][0], seg[1], seg[2]]
        else:
            out.append(list(seg))
    return out


def resolve(m: dict, printed: int) -> int | None:
    """PDF page for a printed page, or None if the scan hasn't got it. Where the
    scan double-fed a page, the longer (i.e. better-attested) run wins; both
    copies hold the same content, so the choice only needs to be deterministic."""
    hits = [s for s in m["segments"] if s[0] <= printed <= s[1]]
    if not hits:
        return None
    best = max(hits, key=lambda s: s[1] - s[0])
    return printed + best[2]


def analyse(stem: str, m: dict) -> list[str]:
    """Human-readable notes: where the scan skips or repeats printed pages, and
    how much of the book the map actually accounts for.

    Coverage is the check that matters. A map that quietly covers a third of the
    book is worse than no map, because every ref outside it goes dark — and
    that's the failure mode when OCR can't find the folios (it truncated three
    books to a fraction of their length before the bands were widened)."""
    segs = m["segments"]
    if not segs:
        return ["NO BODY FOUND — check this book by hand"]
    counts: Counter[int] = Counter()
    for start, end, _off in segs:
        counts.update(range(start, end + 1))
    lo, hi = min(s[0] for s in segs), max(s[1] for s in segs)
    missing = [p for p in range(lo, hi + 1) if p not in counts]
    dupes = sorted(p for p, c in counts.items() if c > 1)
    notes = [f"printed {lo}–{hi}, offsets {sorted({s[2] for s in segs})}, "
             f"{len(segs)} segment(s)"]
    if missing:
        notes.append(f"ABSENT from the scan ({len(missing)}): {compress(missing)}")
    if dupes:
        notes.append(f"scanned twice ({len(dupes)}): {compress(dupes)}")

    cited = sorted(
        int(p) for p in _book_titles().get(stem, {}) if re.fullmatch(r"\d+", p)
    )
    if cited:
        covered = sum(1 for p in cited if p in counts)
        pct = 100 * covered / len(cited)
        line = (f"covers {covered}/{len(cited)} ({pct:.0f}%) of the printed pages "
                f"the index cites ({cited[0]}–{cited[-1]})")
        notes.append(("LOW COVERAGE — " + line) if pct < 95 else line)
    return notes


def compress(nums: list[int]) -> str:
    out, i = [], 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        out.append(str(nums[i]) if i == j else f"{nums[i]}–{nums[j]}")
        i = j + 1
    return ", ".join(out)


# --------------------------------------------------------------------------- #
# Verification
#
# The map is only worth having if it is right, and "the offsets look plausible"
# is exactly the reasoning that shipped the broken one. So the map is checked
# against independent evidence: the master index says which TUNE is on each
# printed page, so we resolve a sample of pages through the map, read the title
# off the scan, and confirm it is the tune the index promised.
# --------------------------------------------------------------------------- #

SAMPLE = 30
EDGE_EXTEND_CAP = 6   # pages we'll try to reclaim at each end of a book


def page_text(doc, pdf_page: int) -> str:
    """Normalised text of a WHOLE page.

    Whole page, not the header: these books routinely put two tunes on a sheet
    (Blue Seven sits under Blues By Five on Real Book Vol. 2 p33), so a title
    check that only reads the top declares every second tune a mismatch — which
    is most of why the older books scored so badly here."""
    if not (1 <= pdf_page <= doc.page_count):
        return ""
    pix = doc[pdf_page - 1].get_pixmap(dpi=DPI)
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("L")
    return _norm(" ".join(text for text, _x, _y in ocr(img)))


def page_shows(doc, pdf_page: int, expected: list[str]) -> bool:
    """Does this physical page carry one of the titles the index expects?"""
    if not expected:
        return False
    seen = page_text(doc, pdf_page)
    return bool(seen) and any(t and t in seen for t in (_norm(e) for e in expected))


def extend_edges(stem: str, segments: list[list[int]], doc) -> list[list[int]]:
    """Reclaim the first and last pages of a book — but only where the scan
    proves it.

    Runs are trimmed to pages whose folio was read, and books routinely print no
    folio on the opening page, so the map stops one or two pages short at each
    end and real charts go dark (Ablution, Afro Centric, A Call For All Demons).

    Stitching an INTERIOR gap is provably safe: the same offset on both sides
    means nothing shifted. At the outer edge there is no other side, so the same
    reasoning would be a guess — and guessing the neighbouring page is precisely
    how printed 4 came to open Airegin. So each reclaimed page is verified
    individually: render it, read the title, and keep it only if it's the tune
    the index promised. Bounded by the pages the index actually cites, which is
    also what keeps this out of Real Book Vol. 1's appendix (cited as A1–A13,
    never as plain numbers).
    """
    titles = _book_titles().get(stem, {})
    cited = sorted(int(p) for p in titles if re.fullmatch(r"\d+", p))
    if not cited or not segments:
        return segments
    segs = [list(s) for s in segments]

    first = segs[0]
    for printed in range(first[0] - 1, max(cited[0], first[0] - EDGE_EXTEND_CAP) - 1, -1):
        if not page_shows(doc, printed + first[2], titles.get(str(printed), [])):
            break
        first[0] = printed

    last = segs[-1]
    for printed in range(last[1] + 1, min(cited[-1], last[1] + EDGE_EXTEND_CAP) + 1):
        if not page_shows(doc, printed + last[2], titles.get(str(printed), [])):
            break
        last[1] = printed
    return segs


def _book_titles() -> dict[str, dict[str, list[str]]]:
    """PDF stem -> {printed page -> [title, …]} from the master index."""
    charts = json.loads((ROOT / "data" / "charts.json").read_text())
    sys.path.insert(0, str(ROOT))
    from app.fakebooks import BOOKS  # noqa: E402  (dev script, path set above)

    stem_for: dict[str, str] = {}
    for name, cfg in BOOKS.items():
        stem_for[Path(cfg["file"]).stem] = name
        for ed in (cfg.get("editions") or {}).values():
            stem_for[Path(ed["file"]).stem] = name

    out: dict[str, dict[str, list[str]]] = {}
    for key, refs in charts.items():
        for ref in refs:
            for stem, name in stem_for.items():
                if name == ref["book"]:
                    out.setdefault(stem, {}).setdefault(ref["page"], []).append(key)
    return out


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def verify(path: Path, m: dict) -> list[str]:
    """Render a spread of mapped pages and check the title against the index."""
    titles = _book_titles().get(path.stem, {})
    pages = sorted(
        (int(p), ts) for p, ts in titles.items() if re.fullmatch(r"\d+", p)
    )
    pages = [(p, ts) for p, ts in pages if resolve(m, p) is not None]
    if not pages:
        return ["VERIFY: no mapped pages to check"]
    step = max(1, len(pages) // SAMPLE)
    sample = pages[::step][:SAMPLE]

    doc = fitz.open(path)
    ok, bad, blank = 0, [], 0
    for printed, expected in sample:
        pdf_page = resolve(m, printed)
        if pdf_page is None or pdf_page > doc.page_count:
            bad.append(f"p{printed}(unmapped)")
            continue
        seen = page_text(doc, pdf_page)
        if not seen:
            blank += 1
            continue
        if any(t and t in seen for t in (_norm(e) for e in expected)):
            ok += 1
        else:
            bad.append(f"p{printed}→pdf{pdf_page} want {expected[0]!r}")
    doc.close()
    checked = ok + len(bad)
    line = f"VERIFY: {ok}/{checked} sampled pages show the tune the index promises"
    if blank:
        line += f" ({blank} unreadable, skipped)"
    out = [line]
    if bad:
        out.append(f"  MISMATCH: {'; '.join(bad[:8])}")
    return out


def main() -> None:
    wanted = [a.upper() for a in sys.argv[1:]]
    files = sorted(p for p in BOOKS_DIR.glob("*.PDF"))
    if wanted:
        files = [p for p in files if p.stem.upper() in wanted]
    if not files:
        sys.exit(f"No PDFs in {BOOKS_DIR}")

    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    for path in files:
        if path.stem not in cache:
            print(f"Reading {path.name} …", flush=True)
            cache[path.stem] = scan_book(path)
            CACHE.write_text(json.dumps(cache))
        else:
            print(f"Reading {path.name} … (cached)", flush=True)

    maps = {}
    for path in files:
        m = build_map(select_folios(cache[path.stem]))
        doc = fitz.open(path)
        m["segments"] = extend_edges(path.stem, m["segments"], doc)
        doc.close()
        maps[path.stem] = m
        print(f"\n{path.name}")
        for note in analyse(path.stem, m):
            print(f"  {note}")
        for line in verify(path, m):
            print(f"  {line}")

    existing = json.loads(OUT.read_text()) if OUT.exists() else {}
    existing.update(maps)
    OUT.write_text(json.dumps(existing, indent=1, sort_keys=True))
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
