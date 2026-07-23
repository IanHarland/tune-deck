"""app/chart_import.py — the charts/ folder loader.

The folder IS the interface: there is no upload UI and no write API. A file
finds its tune through the "(<Book> p<Page>)" reference in its NAME, because
that reference is exact whereas titles differ in spelling between the master
index and the library.

This runs from init_db() during boot, so the hard requirement is that a bad file
is skipped and logged, never fatal.
"""
from __future__ import annotations

import pytest

from app import chart_import, notation
from app.models import TuneTranscription


# --------------------------------------------------------------------------- #
# parse_name
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("stem,expected", [
    ("Autumn Leaves (The New Real Book, Vol. 1 p12)",
     ("Autumn Leaves", "The New Real Book, Vol. 1", "12")),
    ("Donna Lee (The Real Book, Vol. 1 p116)",
     ("Donna Lee", "The Real Book, Vol. 1", "116")),
    ("Alfie (The Real Book, Vol. 1 pA1)",
     ("Alfie", "The Real Book, Vol. 1", "A1")),
    ("Blue Bossa (Jazz LTD p. 42)",
     ("Blue Bossa", "Jazz LTD", "42")),
])
def test_parse_name(stem, expected):
    assert chart_import.parse_name(stem) == expected


def test_parse_name_strips_an_exporter_timestamp():
    """Opuscan prefixes the export with a timestamp."""
    title, book, page = chart_import.parse_name(
        "2026-07-22 17-36 Autumn Leaves (The New Real Book, Vol. 1 p12)")
    assert title == "Autumn Leaves"


def test_parse_name_strips_a_trailing_dup_marker():
    title, book, page = chart_import.parse_name(
        "Autumn Leaves (The New Real Book, Vol. 1 p12)-1")
    assert (title, book, page) == ("Autumn Leaves", "The New Real Book, Vol. 1", "12")


def test_parse_name_tolerates_an_edition_tag():
    """Charts opened from a B♭ printing download with the edition in the name."""
    title, book, page = chart_import.parse_name(
        "Donna Lee (The Real Book, Vol. 1 p116 Bb)")
    assert (title, book, page) == ("Donna Lee", "The Real Book, Vol. 1", "116")


def test_parse_name_uses_the_last_reference():
    """A title with its own parentheses must not be mistaken for the ref."""
    title, book, page = chart_import.parse_name(
        "Nancy (With The Laughing Face) (The Real Book, Vol. 1 p318)")
    assert title == "Nancy (With The Laughing Face)"
    assert (book, page) == ("The Real Book, Vol. 1", "318")


@pytest.mark.parametrize("stem", [
    "Autumn Leaves",                       # no reference at all
    "Autumn Leaves (The New Real Book)",   # book but no page
    "Autumn Leaves p12",                   # no parentheses
])
def test_parse_name_rejects_unusable_names(stem):
    with pytest.raises(chart_import.ChartFileError):
        chart_import.parse_name(stem)


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
def _musicxml(fifths: int = -2) -> str:
    return notation.XML_PROLOG + f"""
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Lead</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions>
        <key><fifths>{fifths}</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch>
            <duration>4</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>
"""


@pytest.fixture
def charted(make_tune):
    """A tune with a chart ref the importer can match against."""
    return make_tune(
        "Autumn Leaves",
        original_key="G-",
        charts=[{"book": "The New Real Book, Vol. 1", "page": "12"}],
    )


@pytest.fixture
def chart_file(tmp_path):
    def _write(name="Autumn Leaves (The New Real Book, Vol. 1 p12).musicxml",
               body=None):
        p = tmp_path / name
        p.write_text(body if body is not None else _musicxml())
        return p
    return _write


# --------------------------------------------------------------------------- #
# _find_tune
# --------------------------------------------------------------------------- #
def test_find_tune_matches_on_the_reference_not_the_title(session, charted):
    """The filename's title can be spelled differently — the ref is what counts."""
    found = chart_import._find_tune(
        session, "The New Real Book, Vol. 1", "12", "AUTUMN LEAVES (misspelled)")
    assert found.id == charted.id


def test_find_tune_no_match_raises(session, charted):
    with pytest.raises(chart_import.ChartFileError, match="no tune has a chart"):
        chart_import._find_tune(session, "Jazz LTD", "999", "Whatever")


def test_find_tune_breaks_ties_on_title(session, make_tune):
    ref = [{"book": "Jazz LTD", "page": "5"}]
    make_tune("Tune One", charts=ref)
    b = make_tune("Tune Two", charts=ref)
    assert chart_import._find_tune(session, "Jazz LTD", "5", "Tune Two").id == b.id


def test_find_tune_ambiguous_tie_raises(session, make_tune):
    ref = [{"book": "Jazz LTD", "page": "5"}]
    make_tune("Tune One", charts=ref)
    make_tune("Tune Two", charts=ref)
    with pytest.raises(chart_import.ChartFileError, match="matches 2 tunes"):
        chart_import._find_tune(session, "Jazz LTD", "5", "Neither Of Them")


def test_find_tune_skips_deleted_tunes(session, make_tune):
    make_tune("Gone", charts=[{"book": "Jazz LTD", "page": "5"}], deleted=True)
    with pytest.raises(chart_import.ChartFileError):
        chart_import._find_tune(session, "Jazz LTD", "5", "Gone")


# --------------------------------------------------------------------------- #
# load_file
# --------------------------------------------------------------------------- #
def test_load_file_adds_a_transcription(session, charted, chart_file):
    assert chart_import.load_file(session, chart_file()) == "added"
    session.commit()
    row = session.query(TuneTranscription).one()
    assert row.tune_id == charted.id
    assert row.book == "The New Real Book, Vol. 1"
    assert row.printed_page == "12"


def test_import_is_marked_verified_and_attributed(session, charted, chart_file):
    """Imports land verified=True — the assumption is you corrected them in
    Soundslice before exporting."""
    chart_import.load_file(session, chart_file())
    session.commit()
    row = session.query(TuneTranscription).one()
    assert row.verified is True
    assert row.model == "soundslice"


def test_source_key_uses_the_tunes_mode(session, charted, chart_file):
    """A 2-flat signature on a minor tune is G minor, not Bb."""
    chart_import.load_file(session, chart_file())
    session.commit()
    assert session.query(TuneTranscription).one().source_key == "G-"


def test_source_key_of_a_major_tune(session, make_tune, chart_file):
    make_tune("Blue Bossa", original_key="C-",
              charts=[{"book": "Jazz LTD", "page": "7"}])
    path = chart_file("Blue Bossa (Jazz LTD p7).musicxml", _musicxml(fifths=-3))
    chart_import.load_file(session, path)
    session.commit()
    assert session.query(TuneTranscription).one().source_key == "C-"


def test_reimporting_identical_content_is_unchanged(session, charted, chart_file):
    """A file whose contents already match is skipped WITHOUT re-vetting, so
    repeat boots are nearly free."""
    p = chart_file()
    assert chart_import.load_file(session, p) == "added"
    session.commit()
    assert chart_import.load_file(session, p) == "unchanged"


def test_reimporting_changed_content_updates_in_place(session, charted, chart_file):
    chart_import.load_file(session, chart_file())
    session.commit()
    assert chart_import.load_file(
        session, chart_file(body=_musicxml(fifths=-1))) == "updated"
    session.commit()
    assert session.query(TuneTranscription).count() == 1


def test_load_file_rejects_a_broken_file(session, charted, chart_file):
    with pytest.raises(chart_import.ChartFileError):
        chart_import.load_file(session, chart_file(body="not xml at all"))


def test_nothing_is_stored_when_vetting_fails(session, charted, chart_file):
    """check_renderable runs BEFORE the row is written, so a file that can't
    engrave in all 12 keys never reaches the database."""
    with pytest.raises(chart_import.ChartFileError):
        chart_import.load_file(session, chart_file(body="<nonsense/>"))
    session.rollback()
    assert session.query(TuneTranscription).count() == 0


# --------------------------------------------------------------------------- #
# load_charts — runs during boot, must never raise
# --------------------------------------------------------------------------- #
def test_load_charts_imports_a_folder(session, charted, chart_file):
    chart_file()
    counts = chart_import.load_charts(session, chart_file().parent)
    assert counts["added"] == 1 and counts["failed"] == 0


def test_load_charts_missing_folder_is_not_an_error(session, tmp_path):
    counts = chart_import.load_charts(session, tmp_path / "does-not-exist")
    assert counts == {"added": 0, "updated": 0, "unchanged": 0, "failed": 0}


def test_load_charts_skips_bad_files_and_keeps_going(session, charted, chart_file):
    """A broken file must never stop the app booting."""
    good = chart_file()
    chart_file("Broken (Nowhere p1).musicxml", "garbage")
    counts = chart_import.load_charts(session, good.parent)
    assert counts["added"] == 1
    assert counts["failed"] == 1


def test_load_charts_ignores_unrelated_files(session, charted, chart_file):
    p = chart_file()
    (p.parent / "README.md").write_text("# notes")
    (p.parent / ".DS_Store").write_bytes(b"\x00")
    counts = chart_import.load_charts(session, p.parent)
    assert counts["added"] == 1 and counts["failed"] == 0


@pytest.mark.parametrize("suffix", [".musicxml", ".xml"])
def test_load_charts_accepts_each_extension(session, charted, chart_file, suffix):
    p = chart_file(f"Autumn Leaves (The New Real Book, Vol. 1 p12){suffix}")
    assert chart_import.load_charts(session, p.parent)["added"] == 1
