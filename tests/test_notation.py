"""app/notation.py — key maths, MusicXML sanitising, and transposition.

The transposition tests matter more than they look: two independent paths exist
(Verovio's `transpose` option for the SVG, notation.transpose_musicxml for the
export), and CLAUDE.md requires they agree. A silent divergence would hand the
user an SVG in one key and a download in another.
"""
from __future__ import annotations

import io
import zipfile

import pytest

from app import notation


# --------------------------------------------------------------------------- #
# parse_key
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("key,expected", [
    ("C", ("C", 0, False)),
    ("Bb", ("B", -1, False)),
    ("F#", ("F", 1, False)),
    ("C#-", ("C", 1, True)),
    ("Cmin", ("C", 0, True)),
    ("Cm", ("C", 0, True)),
    ("g-", ("G", 0, True)),      # lowercase input
    ("  Eb  ", ("E", -1, False)),  # surrounding whitespace
])
def test_parse_key(key, expected):
    assert notation.parse_key(key) == expected


@pytest.mark.parametrize("key", ["", "H", "xyz", "#", None])
def test_parse_key_rejects_garbage(key):
    assert notation.parse_key(key or "") is None


def test_is_minor():
    assert notation.is_minor("G-")
    assert notation.is_minor("Cmin")
    assert not notation.is_minor("Bb")
    assert not notation.is_minor(None)


# --------------------------------------------------------------------------- #
# interval_name — the string handed to Verovio
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("src,dst,expected", [
    ("C", "C", ""),        # no change
    ("C", "Eb", "m3"),
    ("C", "E", "M3"),
    ("C", "F", "P4"),
    ("C", "G", "P5"),
    ("C", "Bb", "m7"),
    ("C", "D", "M2"),
    ("C", "Db", "m2"),
    ("Bb", "C", "M2"),
    ("Eb", "F", "M2"),
    ("F", "Bb", "P4"),
    ("G-", "A-", "M2"),    # minor keys use the same interval maths
])
def test_interval_name(src, dst, expected):
    assert notation.interval_name(src, dst) == expected


def test_interval_name_is_always_ascending():
    """Descending requests wrap up an octave rather than going negative —
    Verovio spells better going up, and it never exceeds an octave."""
    for src, dst in [("C", "Bb"), ("G", "F"), ("Eb", "C")]:
        name = notation.interval_name(src, dst)
        assert name and not name.startswith("-")


def test_interval_name_unparseable():
    assert notation.interval_name("C", "H") is None
    assert notation.interval_name("zzz", "C") is None


def test_interval_name_covers_every_key_pair():
    """Every (src, dst) among the 12 keys must yield a usable interval —
    a None here becomes an un-engravable key pill in the UI."""
    keys = notation.keys_for("C")
    for src in keys:
        for dst in keys:
            assert notation.interval_name(src, dst) is not None, f"{src}->{dst}"


# --------------------------------------------------------------------------- #
# keys_for / key_name_from_fifths
# --------------------------------------------------------------------------- #
def test_keys_for_major_uses_flat_spellings():
    assert notation.keys_for("C") == [
        "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]


def test_keys_for_minor_uses_sharp_spellings():
    """No "Db minor" — it's C# minor. Mirrors MINOR_KEYS in core/keys.ts."""
    assert notation.keys_for("G-") == [
        "C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"]


def test_keys_for_defaults_to_major():
    assert notation.keys_for(None) == notation.keys_for("C")


@pytest.mark.parametrize("fifths,minor,expected", [
    (0, False, "C"),
    (-2, False, "Bb"),
    (1, False, "G"),
    (-3, False, "Eb"),
    (7, False, "C#"),
    (-7, False, "Cb"),
    (-2, True, "G-"),     # 2 flats + minor = G minor, NOT Bb
    (0, True, "A-"),
    (-3, True, "C-"),
])
def test_key_name_from_fifths(fifths, minor, expected):
    assert notation.key_name_from_fifths(fifths, minor) == expected


def test_key_name_from_fifths_clamps_out_of_range():
    assert notation.key_name_from_fifths(99) == notation.key_name_from_fifths(7)
    assert notation.key_name_from_fifths(-99) == notation.key_name_from_fifths(-7)


def test_source_key_of_a_minor_chart_is_the_minor_tonic():
    """Autumn Leaves is G minor under a 2-flat signature — deriving the key from
    the signature alone would wrongly call it Bb. This pairing (fifths + the
    tune's mode) is what app/chart_import.py stores as source_key."""
    assert notation.key_name_from_fifths(-2, minor=True) == "G-"
    assert notation.key_name_from_fifths(-2, minor=False) == "Bb"


# --------------------------------------------------------------------------- #
# MusicXML fixtures
# --------------------------------------------------------------------------- #
def _score(fifths: int = 0, extra_attributes: str = "", staves: str = "") -> bytes:
    return (notation.XML_PROLOG + f"""
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Lead</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>{fifths}</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        {staves}
        <clef><sign>G</sign><line>2</line></clef>
        {extra_attributes}
      </attributes>
      <harmony><root><root-step>C</root-step></root><kind>major</kind></harmony>
      <note><pitch><step>C</step><octave>4</octave></pitch>
            <duration>2</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch>
            <duration>2</duration><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch>
            <duration>4</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>
""").encode()


# --------------------------------------------------------------------------- #
# fifths_of
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("fifths", [0, -1, -2, -3, 1, 4, -7, 7])
def test_fifths_of_reads_the_key_signature(fifths):
    assert notation.fifths_of(_score(fifths).decode()) == fifths


def test_fifths_of_defaults_to_zero_without_a_key():
    xml = notation.XML_PROLOG + (
        "<score-partwise><part-list><score-part id='P1'/></part-list>"
        "<part id='P1'><measure number='1'/></part></score-partwise>")
    assert notation.fifths_of(xml) == 0


# --------------------------------------------------------------------------- #
# sanitize_musicxml — the segfault guard
# --------------------------------------------------------------------------- #
def test_sanitize_accepts_a_plain_score():
    out = notation.sanitize_musicxml(_score())
    assert "score-partwise" in out
    assert out.startswith("<?xml")


def test_sanitize_strips_clefs_for_undeclared_staves():
    """A <clef number="2"> on a one-staff part SEGFAULTS Verovio (Opuscan emits
    exactly this). In-process that kills the gunicorn worker and every in-flight
    request with it — which is what the endless "Engraving…" was."""
    dirty = _score(extra_attributes='<clef number="2"><sign>F</sign><line>4</line></clef>')
    assert b'number="2"' in dirty
    out = notation.sanitize_musicxml(dirty)
    assert 'number="2"' not in out


def test_sanitize_keeps_clefs_the_part_actually_declares():
    """A real two-staff piano part must keep its second clef."""
    xml = _score(staves="<staves>2</staves>",
                 extra_attributes='<clef number="2"><sign>F</sign><line>4</line></clef>')
    out = notation.sanitize_musicxml(xml)
    assert 'number="2"' in out


def test_sanitize_always_emits_the_xml_prolog():
    """Finale and Sibelius reject a file starting at the bare root element."""
    bare = _score().replace(notation.XML_PROLOG.encode(), b"")
    assert notation.sanitize_musicxml(bare).startswith("<?xml")


def test_sanitize_rejects_non_xml():
    with pytest.raises(notation.BadMusicXml):
        notation.sanitize_musicxml(b"this is not xml at all")


def test_sanitize_rejects_empty_input():
    with pytest.raises(notation.BadMusicXml):
        notation.sanitize_musicxml(b"")


# --------------------------------------------------------------------------- #
# .mxl (zipped MusicXML)
# --------------------------------------------------------------------------- #
def _mxl(inner_name: str = "score.xml") -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("META-INF/container.xml", notation.XML_PROLOG + f"""
<container><rootfiles>
  <rootfile full-path="{inner_name}" media-type="application/vnd.recordare.musicxml+xml"/>
</rootfiles></container>""")
        z.writestr(inner_name, _score().decode())
    return buf.getvalue()


def test_mxl_is_unwrapped_transparently():
    out = notation.sanitize_musicxml(_mxl())
    assert "score-partwise" in out


def test_mxl_honours_container_rootfile_path():
    """The inner score can be named anything; META-INF/container.xml says which."""
    out = notation.sanitize_musicxml(_mxl("scores/lead-sheet.musicxml"))
    assert "score-partwise" in out


def test_corrupt_zip_is_a_clean_error_not_a_crash():
    with pytest.raises(notation.BadMusicXml):
        notation.sanitize_musicxml(b"PK\x03\x04corrupted-zip-bytes")


# --------------------------------------------------------------------------- #
# transpose_musicxml
# --------------------------------------------------------------------------- #
def test_transpose_none_is_a_passthrough():
    xml = notation.sanitize_musicxml(_score())
    assert notation.transpose_musicxml(xml, None) == xml
    assert notation.transpose_musicxml(xml, "") == xml


def test_transpose_moves_the_key_signature():
    """C major up a minor third = Eb major = 3 flats."""
    xml = notation.sanitize_musicxml(_score(0))
    assert notation.fifths_of(notation.transpose_musicxml(xml, "m3")) == -3


def test_transpose_moves_the_notes():
    xml = notation.sanitize_musicxml(_score(0))
    out = notation.transpose_musicxml(xml, "M2")  # C -> D
    assert "<step>D</step>" in out
    assert "<step>F</step>" in out and "alter" in out  # E -> F#


def test_transpose_moves_chord_symbols():
    """Chords are the part of a lead sheet that must survive — a transposed
    melody over untransposed changes is worse than no transposition."""
    xml = notation.sanitize_musicxml(_score(0))
    out = notation.transpose_musicxml(xml, "P4")  # C -> F
    assert "<root-step>F</root-step>" in out


def test_transpose_round_trip_returns_the_original_key():
    xml = notation.sanitize_musicxml(_score(0))
    up = notation.transpose_musicxml(xml, "P5")
    back = notation.transpose_musicxml(up, "P4")  # P5 + P4 = octave
    assert notation.fifths_of(back) == notation.fifths_of(xml)


@pytest.mark.parametrize("dst", ["Db", "D", "Eb", "E", "F", "Gb",
                                 "G", "Ab", "A", "Bb", "B"])
def test_transpose_to_every_key_stays_well_formed(dst):
    """Every key pill must produce a parseable file — this is the export path."""
    import xml.etree.ElementTree as ET

    xml = notation.sanitize_musicxml(_score(0))
    out = notation.transpose_musicxml(xml, notation.interval_name("C", dst))
    ET.fromstring(out)  # raises if malformed
    assert "score-partwise" in out


def test_transposed_key_signature_matches_the_target_key():
    """The signature after transposing must be the one that key actually has."""
    expected = {"C": 0, "Db": -5, "D": 2, "Eb": -3, "E": 4, "F": -1,
                "G": 1, "Ab": -4, "A": 3, "Bb": -2, "B": 5}
    xml = notation.sanitize_musicxml(_score(0))
    for dst, fifths in expected.items():
        out = notation.transpose_musicxml(xml, notation.interval_name("C", dst))
        assert notation.fifths_of(out) == fifths, dst


# --------------------------------------------------------------------------- #
# Rendering (Verovio). Slow-ish but this is the path that used to segfault.
# --------------------------------------------------------------------------- #
def test_render_svg_produces_an_svg():
    svg = notation.render_svg(notation.sanitize_musicxml(_score()))
    assert "<svg" in svg


def test_render_svg_does_not_inline_the_music_font():
    """Verovio inlines 58 KB of base64 WOFF2 per SVG unless told not to; we link
    the stylesheet instead (49 KB gzipped per key vs 4.4 KB)."""
    svg = notation.render_svg(notation.sanitize_musicxml(_score()))
    assert "base64" not in svg


FLAT_GLYPH = "E260"  # SMuFL accidentalFlat
SHARP_GLYPH = "E262"  # SMuFL accidentalSharp


def _glyphs(svg: str) -> list[str]:
    """The ordered SMuFL glyph codes in a render — clef, key signature,
    noteheads. Verovio stamps a fresh random id on every element, so SVGs are
    never byte-comparable; the glyph sequence is both stable and directly
    musical, so a difference here means the ENGRAVING really changed."""
    import re

    return re.findall(r'href="#(E[0-9A-F]{3})', svg)


def test_render_transpose_option_does_not_leak_between_calls():
    """verovio setOptions() MERGES — an absent `transpose` silently keeps the
    PREVIOUS render's interval. If that regresses, the untransposed render after
    a transposed one comes back in the wrong key, with no error anywhere."""
    xml = notation.sanitize_musicxml(_score(0))
    plain_fresh = _glyphs(notation.render_svg(xml, None))
    notation.render_svg(xml, "P5")               # poison the toolkit
    plain_after = _glyphs(notation.render_svg(xml, None))
    assert plain_after == plain_fresh


def test_render_transpose_actually_changes_the_engraving():
    """Guards the guard: if transposing were a no-op the leak test above would
    pass vacuously. C major -> Eb major must add exactly three flats."""
    xml = notation.sanitize_musicxml(_score(0))
    in_c = _glyphs(notation.render_svg(xml, None))
    in_eb = _glyphs(notation.render_svg(xml, "m3"))
    assert in_c.count(FLAT_GLYPH) == 0
    assert in_eb.count(FLAT_GLYPH) == 3


def test_render_key_signature_matches_the_target_key():
    """The engraved signature must match the key the pill claims. A wrong count
    here is the failure mode that looks fine and reads wrong on the stand."""
    xml = notation.sanitize_musicxml(_score(0))
    flats = {"F": 1, "Bb": 2, "Eb": 3, "Ab": 4, "Db": 5}
    sharps = {"G": 1, "D": 2, "A": 3, "E": 4, "B": 5}
    for dst, n in flats.items():
        g = _glyphs(notation.render_svg(xml, notation.interval_name("C", dst)))
        assert g.count(FLAT_GLYPH) == n, f"{dst} should have {n} flats"
    for dst, n in sharps.items():
        g = _glyphs(notation.render_svg(xml, notation.interval_name("C", dst)))
        assert g.count(SHARP_GLYPH) == n, f"{dst} should have {n} sharps"


def test_font_css_exists():
    """Without this stylesheet, chord-symbol accidentals render as tofu boxes."""
    assert notation.font_css_path().exists()


# --------------------------------------------------------------------------- #
# check_renderable — the out-of-process guard
# --------------------------------------------------------------------------- #
def test_check_renderable_passes_a_good_file():
    xml = notation.sanitize_musicxml(_score(0))
    notation.check_renderable(xml, ["", "m3", "P5"])  # must not raise


def test_check_renderable_rejects_junk():
    with pytest.raises(notation.BadMusicXml):
        notation.check_renderable("<not-a-score/>", [""])


def test_check_renderable_runs_out_of_process():
    """The whole point: a Verovio segfault must come back as an exit code, not
    take down the worker. If this ran in-process a bad file would kill pytest."""
    import subprocess
    import sys

    proc = subprocess.run(
        [sys.executable, "-m", "app.notation", ""],
        input=notation.sanitize_musicxml(_score()).encode(),
        capture_output=True,
    )
    assert proc.returncode == 0
