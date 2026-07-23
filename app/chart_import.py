"""Load hand-made MusicXML charts out of a folder into the database.

The workflow this serves: open a chart in Tune Deck (which downloads it as
"<Title> (<Book> p<Page>).pdf"), scan that PDF in Soundslice, correct whatever
the scanner misread, export MusicXML — the export keeps the same base name —
and drop the file in CHARTS_DIR. There is deliberately no upload UI; the folder
IS the interface, and it ships in the image the same way books/ does.

Runs from init_db() on every boot and is idempotent: a file whose contents
already match the stored row is skipped without re-vetting, so repeat boots are
nearly free and only genuinely new or changed charts pay the render check.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import notation
from .models import Tune, TuneTranscription

CHARTS_DIR = Path(os.environ.get(
    "CHARTS_DIR",
    str(Path(__file__).resolve().parent.parent / "charts"),
))

SUFFIXES = {".musicxml", ".xml", ".mxl"}

# Exporters like to decorate the name. Opuscan prefixes a timestamp and appends
# "-1"; both sit outside the "(Book pPage)" reference, so stripping the stamp is
# enough to recover the title.
_STAMP = re.compile(r"^\d{4}-\d{2}-\d{2}[ _]\d{2}[-:.]\d{2}\s+")
# "(The New Real Book, Vol. 1 p12)" / "(The Real Book, Vol. 1 p153 Bb)" —
# the trailing edition tag appears when the PDF was opened in a B♭/E♭ printing.
# The page may carry a section letter ("A1"), same as everywhere else.
_REF = re.compile(
    r"\((?P<book>[^()]+?)\s+p\.?\s*(?P<page>[A-Za-z]?\d{1,4})"
    r"(?:\s+(?:Bb|Eb))?\)")


class ChartFileError(ValueError):
    """This file can't be matched to a chart. Message is for the console."""


def parse_name(stem: str) -> tuple[str, str, str]:
    """"Autumn Leaves (The New Real Book, Vol. 1 p12)" -> (title, book, page).

    Uses the LAST reference in the name, so a title with its own parentheses
    ("Nancy (With The Laughing Face)") doesn't get mistaken for one.
    """
    matches = list(_REF.finditer(stem))
    if not matches:
        raise ChartFileError(
            'name it "<Title> (<Book> p<Page>).musicxml" — that is exactly the '
            "name Tune Deck gives the PDF you scanned")
    m = matches[-1]
    title = _STAMP.sub("", stem[:m.start()]).strip(" -_")
    return title, m.group("book").strip(), m.group("page").strip()


def _find_tune(session: Session, book: str, page: str, title: str) -> Tune:
    """The tune this chart belongs to.

    Matched on the (book, page) reference rather than the title: the reference
    is exact, whereas titles differ in spelling between the index and the
    library. Title only breaks a tie.
    """
    tunes = session.execute(
        select(Tune).where(Tune.deleted.is_(False))).scalars().all()
    hits = [t for t in tunes
            if any(c.get("book") == book and str(c.get("page")) == page
                   for c in (t.charts or []))]
    if not hits:
        raise ChartFileError(f"no tune has a chart at {book} p.{page}")
    if len(hits) > 1:
        want = title.strip().lower()
        exact = [t for t in hits if (t.title or "").strip().lower() == want]
        if len(exact) != 1:
            raise ChartFileError(
                f"{book} p.{page} matches {len(hits)} tunes "
                f"({', '.join(t.title for t in hits[:3])}) — rename the file to "
                f"one of them exactly")
        hits = exact
    return hits[0]


def load_file(session: Session, path: Path) -> str:
    """Import one file. Returns a one-word outcome: added/updated/unchanged."""
    title, book, page = parse_name(path.stem)
    tune = _find_tune(session, book, page, title)

    try:
        musicxml = notation.sanitize_musicxml(path.read_bytes())
    except notation.BadMusicXml as e:
        raise ChartFileError(str(e)) from e

    row = session.execute(
        select(TuneTranscription).where(
            TuneTranscription.tune_id == tune.id,
            TuneTranscription.book == book,
            TuneTranscription.printed_page == page,
        )
    ).scalar_one_or_none()

    if row is not None and row.musicxml == musicxml:
        return "unchanged"

    # Prove it engraves in every key BEFORE it is stored — out-of-process,
    # because Verovio can segfault on MusicXML it dislikes and in-process that
    # would take the whole worker down. See notation.check_renderable.
    src = notation.key_name_from_fifths(
        notation.fifths_of(musicxml), minor=notation.is_minor(tune.original_key))
    try:
        notation.check_renderable(
            musicxml,
            [notation.interval_name(src, k) or "" for k in notation.keys_for(src)])
    except notation.BadMusicXml as e:
        raise ChartFileError(str(e)) from e

    added = row is None
    if added:
        row = TuneTranscription(tune_id=tune.id, book=book, printed_page=page)
        session.add(row)
    row.musicxml = musicxml
    row.source_key = src
    row.model = "soundslice"
    row.verified = True  # corrected by hand before export
    return "added" if added else "updated"


def load_charts(session: Session, directory: Path | None = None) -> dict[str, int]:
    """Import every chart file in `directory`. Never raises — a bad file is
    reported and skipped, because this runs during startup."""
    d = Path(directory) if directory else CHARTS_DIR
    counts = {"added": 0, "updated": 0, "unchanged": 0, "failed": 0}
    if not d.is_dir():
        return counts

    files = sorted(p for p in d.iterdir()
                   if p.suffix.lower() in SUFFIXES and not p.name.startswith("."))
    for path in files:
        try:
            counts[load_file(session, path)] += 1
        except ChartFileError as e:
            counts["failed"] += 1
            print(f"[charts] SKIPPED {path.name}: {e}")
        except Exception as e:  # a bad file must never stop the app booting
            counts["failed"] += 1
            print(f"[charts] SKIPPED {path.name}: unexpected {type(e).__name__}: {e}")
    session.commit()

    if any(counts[k] for k in ("added", "updated", "failed")):
        print(f"[charts] {counts['added']} added, {counts['updated']} updated, "
              f"{counts['unchanged']} unchanged, {counts['failed']} failed "
              f"(from {d})")
    return counts


if __name__ == "__main__":  # check the folder locally before deploying
    import sys

    from .db import SessionLocal, init_db

    # init_db() already imports the folder, so this second pass is the
    # idempotency check: a healthy run reports everything "unchanged".
    init_db()
    with SessionLocal() as s:
        result = load_charts(s, Path(sys.argv[1]) if len(sys.argv) > 1 else None)
    print(f"re-run (should be all unchanged): {result}")
    sys.exit(1 if result["failed"] else 0)
