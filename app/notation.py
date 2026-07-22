"""Transpose + engrave a lead sheet.

Takes the MusicXML transcription of a chart (see transcribe.py), transposes it
to any key, and engraves it to SVG with Verovio.

Rendering is server-side on purpose. Verovio also ships as WASM, but the browser
build is several MB — the app deliberately dropped react-pdf for being 1.5 MB
(CLAUDE.md), and it still targets iPadOS 14 Safari. Keeping Verovio on the
server costs one warm round-trip (~70 ms) per key and nothing in the bundle.
"""
from __future__ import annotations

import re
import threading
import xml.etree.ElementTree as ET
from functools import lru_cache
from pathlib import Path

import verovio

# Diatonic letter -> (scale-step index, semitones above C).
_LETTER = {"C": (0, 0), "D": (1, 2), "E": (2, 4), "F": (3, 5),
           "G": (4, 7), "A": (5, 9), "B": (6, 11)}
# Semitone span of each perfect/major interval, indexed by diatonic step count.
_NATURAL = [0, 2, 4, 5, 7, 9, 11]
# Which interval sizes are "perfect" (unison, 4th, 5th) vs "major" (2nd,3rd,6th,7th).
_PERFECT = {0, 3, 4}


def parse_key(key: str) -> tuple[str, int, bool] | None:
    """'Bb' -> ('B', -1, False); 'C#-' / 'Cmin' -> ('C', 1, True). Returns
    (letter, alteration, is_minor) or None if unparseable. Mirrors the minor
    conventions in frontend/src/core/keys.ts."""
    if not key:
        return None
    k = key.strip()
    m = re.match(r"^([A-Ga-g])([b#]?)", k)
    if not m:
        return None
    letter = m.group(1).upper()
    alter = {"b": -1, "#": 1, "": 0}[m.group(2)]
    rest = k[m.end():].strip().lower()
    minor = rest.startswith("-") or rest.startswith("m")
    return letter, alter, minor


def _pitch_class(letter: str, alter: int) -> int:
    return (_LETTER[letter][1] + alter) % 12


def interval_name(src: str, dst: str) -> str | None:
    """Verovio transposition interval taking key `src` to key `dst`, e.g.
    ('C','Eb') -> 'm3', ('C','F') -> 'P4'. Always the ascending form (0-11
    semitones), which keeps spelling sane and never exceeds an octave.

    Returns None if either key is unparseable, or '' for no change.
    """
    a, b = parse_key(src), parse_key(dst)
    if not a or not b:
        return None
    steps = (_LETTER[b[0]][0] - _LETTER[a[0]][0]) % 7
    semis = (_pitch_class(b[0], b[1]) - _pitch_class(a[0], a[1])) % 12
    if steps == 0 and semis == 0:
        return ""

    natural = _NATURAL[steps]
    # Wrap the comparison: a 7th spanning 0 semitones is really an octave-ish
    # edge case, so bring the difference into [-6, 6].
    diff = semis - natural
    if diff > 6:
        diff -= 12
    elif diff < -6:
        diff += 12

    size = steps + 1  # diatonic interval number (1 = unison, 2 = second, ...)
    if steps in _PERFECT:
        qual = {0: "P", 1: "A", -1: "d"}.get(diff)
    else:
        qual = {0: "M", -1: "m", 1: "A", -2: "d"}.get(diff)
    if qual is None:
        return None
    return f"{qual}{size}"


# --- MusicXML assembly ------------------------------------------------- #
# Built from the transcription JSON (see transcribe.SCHEMA) rather than asking
# the model for XML directly: a JSON schema is guaranteed well-formed.

DIVISIONS = 4  # divisions per quarter note

# duration token -> (divisions, MusicXML <type>, dot count)
_DUR = {
    "16": (1, "16th", 0), "8": (2, "eighth", 0), "8.": (3, "eighth", 1),
    "4": (4, "quarter", 0), "4.": (6, "quarter", 1), "2": (8, "half", 0),
    "2.": (12, "half", 1), "1": (16, "whole", 0),
}

# MusicXML kind -> the suffix jazz players actually read.
_KIND_TEXT = {
    "major": "", "minor": "mi", "dominant": "7", "major-seventh": "Ma7",
    "minor-seventh": "mi7", "half-diminished": "mi7(b5)", "diminished": "dim",
    "augmented": "+", "major-sixth": "6", "minor-sixth": "mi6",
    "minor-major": "mi(Ma7)", "suspended-fourth": "sus4",
    "dominant-ninth": "9", "major-ninth": "Ma9", "minor-ninth": "mi9",
    "dominant-13th": "13", "power": "5",
}

_ALTER = {"b": -1, "#": 1, "bb": -2, "##": 2, "": 0}


def _esc(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _note_xml(n: dict) -> str:
    dur = n.get("dur", "4")
    if dur not in _DUR:
        dur = "4"
    divs, typ, dots = _DUR[dur]
    pitch = (n.get("pitch") or "r").strip()
    tie = n.get("tie") or "none"
    stac = bool(n.get("staccato"))

    out = ["  <note>"]
    if pitch == "r":
        out.append("    <rest/>")
    else:
        step, acc, octv = pitch[0].upper(), pitch[1:-1], pitch[-1]
        out.append("    <pitch>")
        out.append(f"      <step>{step}</step>")
        if _ALTER.get(acc):
            out.append(f"      <alter>{_ALTER[acc]}</alter>")
        out.append(f"      <octave>{octv}</octave>")
        out.append("    </pitch>")
    out.append(f"    <duration>{divs}</duration>")
    if tie in ("start", "stop"):
        out.append(f'    <tie type="{tie}"/>')
    out.append(f"    <type>{typ}</type>")
    out += ["    <dot/>"] * dots
    if tie in ("start", "stop") or stac:
        out.append("    <notations>")
        if tie in ("start", "stop"):
            out.append(f'      <tied type="{tie}"/>')
        if stac:
            out.append("      <articulations><staccato/></articulations>")
        out.append("    </notations>")
    out.append("  </note>")
    return "\n".join(out)


def _harmony_xml(h: dict) -> str:
    root = (h.get("root") or "C").strip()
    kind = h.get("kind") or "major"
    step, acc = root[0].upper(), root[1:]
    lines = ["  <harmony>", "    <root>", f"      <root-step>{step}</root-step>"]
    if _ALTER.get(acc):
        lines.append(f"      <root-alter>{_ALTER[acc]}</root-alter>")
    lines += ["    </root>",
              f'    <kind text="{_esc(_KIND_TEXT.get(kind, ""))}">{kind}</kind>',
              "  </harmony>"]
    return "\n".join(lines)


# Every MusicXML file must carry this prolog — importers (Finale, Sibelius)
# reject a file that starts at the bare <score-partwise> element.
XML_PROLOG = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN"
  "http://www.musicxml.org/dtds/partwise.dtd">
"""


def build_musicxml(data: dict) -> str:
    """Transcription JSON -> MusicXML. See transcribe.SCHEMA for the shape."""
    fifths = max(-7, min(7, int(data.get("key_fifths", 0))))
    beats = int(data.get("beats") or 4)
    beat_type = int(data.get("beat_type") or 4)
    head = XML_PROLOG + f"""<score-partwise version="4.0">
 <work><work-title>{_esc(data.get("title") or "")}</work-title></work>
 <identification><creator type="composer">{_esc(data.get("composer") or "")}</creator></identification>
 <part-list><score-part id="P1"><part-name></part-name></score-part></part-list>
 <part id="P1">"""
    body = []
    for i, m in enumerate(data.get("measures") or [], 1):
        body.append(f'  <measure number="{i}">')
        if i == 1:
            body.append(f"""   <attributes>
    <divisions>{DIVISIONS}</divisions>
    <key><fifths>{fifths}</fifths></key>
    <time><beats>{beats}</beats><beat-type>{beat_type}</beat-type></time>
    <clef><sign>G</sign><line>2</line></clef>
   </attributes>""")
        for h in (m.get("harmony") or []):
            body.append(_harmony_xml(h))
        notes = m.get("notes") or []
        if not notes:  # never emit an empty measure — Verovio renders it as a gap
            notes = [{"pitch": "r", "dur": "1"}]
        for n in notes:
            body.append(_note_xml(n))
        body.append("  </measure>")
    return head + "\n" + "\n".join(body) + "\n </part>\n</score-partwise>\n"


# --- Transposing the MusicXML itself ------------------------------------ #
# Verovio transposes for RENDERING but can only export MEI, so exporting
# transposed MusicXML (for MuseScore/Sibelius) needs its own implementation.

_LETTERS = ["C", "D", "E", "F", "G", "A", "B"]
# position on the circle of fifths for each natural, used for key signatures
_FIFTHS_OF = {"F": -1, "C": 0, "G": 1, "D": 2, "A": 3, "E": 4, "B": 5}

_MAJOR_BY_FIFTHS = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C",
                    "G", "D", "A", "E", "B", "F#", "C#"]
_MINOR_BY_FIFTHS = ["Ab", "Eb", "Bb", "F", "C", "G", "D", "A",
                    "E", "B", "F#", "C#", "G#", "D#", "A#"]


def is_minor(key: str | None) -> bool:
    p = parse_key(key or "")
    return bool(p and p[2])


def key_name_from_fifths(fifths: int, minor: bool = False) -> str:
    """Key signature accidental count -> tonic name ('-3', minor -> 'C-')."""
    f = max(-7, min(7, int(fifths)))
    name = (_MINOR_BY_FIFTHS if minor else _MAJOR_BY_FIFTHS)[f + 7]
    return f"{name}-" if minor else name


def _interval_parts(name: str) -> tuple[int, int] | None:
    """'m3' -> (diatonic steps, semitones) == (2, 3). Inverse of interval_name."""
    m = re.match(r"^([PMmAd])(\d+)$", (name or "").strip())
    if not m:
        return None
    qual, number = m.group(1), int(m.group(2))
    if number < 1:
        return None
    steps = number - 1
    natural = _NATURAL[steps % 7] + 12 * (steps // 7)
    if steps % 7 in _PERFECT:
        delta = {"P": 0, "A": 1, "d": -1}.get(qual)
    else:
        delta = {"M": 0, "m": -1, "A": 1, "d": -2}.get(qual)
    if delta is None:
        return None
    return steps, natural + delta


def _transpose_pitch(step: str, alter: int, octave: int,
                     steps: int, semis: int) -> tuple[str, int, int]:
    """Transpose one spelled pitch, preserving correct enharmonic spelling."""
    idx = _LETTER[step][0] + steps
    new_step = _LETTERS[idx % 7]
    natural = _LETTER[new_step][1]
    # absolute semitone, C0 = 0
    old_abs = 12 * octave + _LETTER[step][1] + alter
    new_abs = old_abs + semis
    new_alter = (new_abs - natural) % 12
    if new_alter > 6:
        new_alter -= 12
    new_octave = (new_abs - natural - new_alter) // 12
    return new_step, new_alter, new_octave


def _fifths_delta(steps: int, semis: int) -> int:
    """How far the key signature moves round the circle for this interval."""
    step, alter, _oct = _transpose_pitch("C", 0, 4, steps, semis)
    return _FIFTHS_OF[step] + 7 * alter


def transpose_musicxml(musicxml: str, interval: str | None) -> str:
    """Return MusicXML transposed by a Verovio-style interval ('P4', 'm3').

    Rewrites note pitches, chord-symbol roots/bass, and the key signature.
    An empty/None interval returns the input unchanged.
    """
    if not interval:
        return musicxml
    parts = _interval_parts(interval)
    if parts is None:
        raise ValueError(f"unrecognised interval {interval!r}")
    steps, semis = parts

    root = ET.fromstring(musicxml)

    for fifths_el in root.iter("fifths"):
        try:
            cur = int((fifths_el.text or "0").strip())
        except ValueError:
            cur = 0
        # Past ±7 a key signature needs double accidentals; clamping keeps the
        # export readable, and keys_for() never offers a target that gets here.
        fifths_el.text = str(max(-7, min(7, cur + _fifths_delta(steps, semis))))

    def shift(step_el, alter_el, octave_el, parent):
        step = (step_el.text or "C").strip().upper()
        if step not in _LETTER:
            return
        alter = 0
        if alter_el is not None:
            try:
                alter = int(float((alter_el.text or "0").strip()))
            except ValueError:
                alter = 0
        octave = 4
        if octave_el is not None:
            try:
                octave = int((octave_el.text or "4").strip())
            except ValueError:
                octave = 4
        new_step, new_alter, new_octave = _transpose_pitch(step, alter, octave, steps, semis)
        step_el.text = new_step
        if octave_el is not None:
            octave_el.text = str(new_octave)
        if new_alter:
            if alter_el is None:
                alter_el = ET.SubElement(parent, "alter")
                parent.remove(alter_el)
                parent.insert(list(parent).index(step_el) + 1, alter_el)
            alter_el.text = str(new_alter)
        elif alter_el is not None:
            parent.remove(alter_el)

    for pitch in root.iter("pitch"):
        shift(pitch.find("step"), pitch.find("alter"), pitch.find("octave"), pitch)

    # Chord symbols: <root><root-step>/<root-alter>, and any <bass> slash chord.
    for tag, prefix in (("root", "root"), ("bass", "bass")):
        for el in root.iter(tag):
            step_el = el.find(f"{prefix}-step")
            if step_el is None:
                continue
            shift(step_el, el.find(f"{prefix}-alter"), None, el)
            # keep the alter element's tag name consistent with its parent
            for child in list(el):
                if child.tag == "alter":
                    child.tag = f"{prefix}-alter"

    # ET.tostring() emits the bare root element — no XML declaration and no
    # DOCTYPE. Finale (and Sibelius) reject a MusicXML file without them, so
    # put back the same prolog build_musicxml() writes.
    return XML_PROLOG + ET.tostring(root, encoding="unicode")


# Verovio's toolkit must be a true singleton AND used one-at-a-time.
#
# Two hazards, both bit us in production (2026-07-22):
#  1. Font resources are process-global. Constructing a SECOND toolkit tears
#     down the first one's fonts, after which every loadData() fails with
#     "could not parse MusicXML" — permanently, until the process restarts.
#     functools.lru_cache does NOT prevent this: concurrent cache misses each
#     invoke the wrapped function, so two threads racing on a cold process both
#     build one. With gunicorn --threads 4 on a scale-to-zero machine, the first
#     burst of requests after a wake is exactly that race.
#  2. The toolkit carries mutable state (loaded score + options), so two
#     concurrent renders would interleave setOptions/loadData/renderToSVG and
#     could return the wrong key's engraving rather than failing loudly.
#
# One lock covers construction and use. Renders are ~70 ms; serialising them is
# far cheaper than either failure mode.
_TOOLKIT_LOCK = threading.Lock()
_TOOLKIT = None


def _toolkit():
    """Caller MUST hold _TOOLKIT_LOCK."""
    global _TOOLKIT
    if _TOOLKIT is None:
        _TOOLKIT = verovio.toolkit()
    return _TOOLKIT


@lru_cache(maxsize=1)
def font_css_path() -> Path:
    """Verovio's Leipzig @font-face CSS, served from the installed package.

    render_svg() uses smuflTextFont="linked", so the SVG references
    `font-family: Leipzig` instead of inlining the font. Embedding costs 58 KB
    of base64 WOFF2 in EVERY svg (49 KB gzipped vs 4.4 KB linked) — and it's
    byte-identical across all 12 keys, so it belongs in one cacheable request.
    Read from the package rather than vendored so it can't drift from the
    verovio version actually rendering.
    """
    return Path(verovio.__file__).parent / "data" / "Leipzig.css"


def render_svg(musicxml: str, transpose: str | None = None,
               width: int = 2100) -> str:
    """Engrave MusicXML to a single SVG, optionally transposed.

    `transpose` is a Verovio interval ('P4', 'm3', ...) — use interval_name().
    The result needs font_css_path()'s CSS in the document to draw chord-symbol
    accidentals; without it they fall back to tofu boxes.

    Raises ValueError if the MusicXML won't load.
    """
    opts = {
        "pageWidth": width,
        "pageHeight": 60000,      # tall; adjustPageHeight trims to content
        "scale": 40,
        "adjustPageHeight": True,
        "breaks": "auto",
        "header": "none",
        "footer": "none",
        "spacingStaff": 8,
        "smuflTextFont": "linked",
        # setOptions merges, so an absent transpose must be cleared explicitly
        # or the previous render's interval silently persists.
        "transpose": transpose or "",
    }
    # setOptions -> loadData -> renderToSVG is one indivisible transaction on
    # shared mutable state; see the lock's comment above.
    with _TOOLKIT_LOCK:
        tk = _toolkit()
        tk.setOptions(opts)
        if not tk.loadData(musicxml):
            raise ValueError("could not parse MusicXML")
        return tk.renderToSVG(1)


def keys_for(original_key: str | None) -> list[str]:
    """The 12 keys this tune can be transposed into, spelled per its mode.
    Matches MAJOR_KEYS / MINOR_KEYS in core/keys.ts and web.py."""
    parsed = parse_key(original_key or "")
    minor = bool(parsed and parsed[2])
    if minor:
        return ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"]
    return ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
