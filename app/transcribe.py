"""Transcribe a scanned fake-book chart into symbolic notation.

Classical OMR (Audiveris, oemer) was evaluated against these scans and rejected:
oemer took ~4 min/page and got the key signature, time signature and most
pitches wrong on New Real Book p.25, and Audiveris has no chord-symbol support
at all (its issue #243, open since 2019) — disqualifying for lead sheets.
A vision model reads these pages correctly, so that's what this uses.

The model returns a constrained JSON note-list (structured outputs), NOT raw
MusicXML — a JSON schema is guaranteed well-formed, whereas hand-written XML
from a model is not. notation.build_musicxml() turns it into MusicXML.

Transcription is expensive and immutable once verified, so results are cached
per tune (see models.TuneTranscription) and this only ever runs on a miss.
"""
from __future__ import annotations

import base64
import io
import json

import anthropic
import fitz  # PyMuPDF

from . import fakebooks

MODEL = "claude-opus-4-8"

# Opus 4.8 reads images up to 2576px on the long edge; a US-Letter page at
# 220 dpi lands just under that, so nothing is downscaled server-side.
RENDER_DPI = 220

DURATIONS = ["16", "8", "8.", "4", "4.", "2", "2.", "1"]
KINDS = [
    "major", "minor", "dominant", "major-seventh", "minor-seventh",
    "half-diminished", "diminished", "augmented", "major-sixth",
    "minor-sixth", "minor-major", "suspended-fourth", "dominant-ninth",
    "major-ninth", "minor-ninth", "dominant-13th", "power",
]

# Structured-outputs schema. Numeric constraints (minimum/maximum) aren't
# supported, so ranges are stated in the descriptions instead.
SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "composer": {"type": "string"},
        "key_fifths": {
            "type": "integer",
            "description": "Key signature as a count of accidentals, -7..7. "
                           "Negative = flats, positive = sharps. Read it off "
                           "the printed staff, do not infer it from the chords.",
        },
        "beats": {"type": "integer", "description": "Time signature numerator, e.g. 4 or 3."},
        "beat_type": {"type": "integer", "description": "Time signature denominator, e.g. 4."},
        "pickup": {
            "type": "boolean",
            "description": "True if the chart opens with a pickup/anacrusis bar.",
        },
        "measures": {
            "type": "array",
            "description": "Measures in printed order, left to right, top to bottom.",
            "items": {
                "type": "object",
                "properties": {
                    "harmony": {
                        "type": "array",
                        "description": "Chord symbols printed over this measure, in order.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "root": {
                                    "type": "string",
                                    "description": "Chord root as printed: A-G with an "
                                                   "optional b or # (e.g. 'Bb', 'F#').",
                                },
                                "kind": {"type": "string", "enum": KINDS},
                            },
                            "required": ["root", "kind"],
                            "additionalProperties": False,
                        },
                    },
                    "notes": {
                        "type": "array",
                        "description": "Melody notes and rests, in order. Durations must "
                                       "sum to a full measure (except a pickup bar).",
                        "items": {
                            "type": "object",
                            "properties": {
                                "pitch": {
                                    "type": "string",
                                    "description": "Scientific pitch with explicit accidental "
                                                   "spelling, e.g. 'Eb5', 'F#4', 'C5'. Use 'r' "
                                                   "for a rest. Spell accidentals as they sound "
                                                   "under the key signature, not as printed "
                                                   "(a note under a 3-flat signature on the E "
                                                   "line is 'Eb', with no printed accidental).",
                                },
                                "dur": {"type": "string", "enum": DURATIONS},
                                "tie": {
                                    "type": "string",
                                    "enum": ["start", "stop", "none"],
                                    "description": "'start' on the first note of a tie, 'stop' "
                                                   "on the second, otherwise 'none'.",
                                },
                                "staccato": {"type": "boolean"},
                            },
                            "required": ["pitch", "dur", "tie", "staccato"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["harmony", "notes"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "composer", "key_fifths", "beats", "beat_type",
                 "pickup", "measures"],
    "additionalProperties": False,
}

SYSTEM = """\
You transcribe scanned jazz lead sheets into symbolic notation.

Transcribe exactly what is printed on the page — the melody line and the chord
symbols above it. Work measure by measure, left to right and top to bottom.

Rules that matter most, in order:
1. Read the key signature and time signature off the printed staff. These are
   the most consequential fields: everything downstream is transposed relative
   to the key, so a wrong key signature corrupts the whole chart.
2. Spell pitches as they SOUND under the key signature. A note on the middle
   line under three flats is Bb even though no flat is printed next to it.
   Apply printed accidentals, and carry them for the rest of that measure.
3. Note durations in each measure must sum to a full measure. If they don't,
   you have misread a duration — recount that measure before moving on.
4. Transcribe the melody staff only. Fake books often print a second staff of
   rhythm slashes or a sample bass line; ignore it.
5. Write out repeated sections as printed. Do NOT expand repeat signs, first
   and second endings, D.S. or coda jumps into repeated measures — transcribe
   the measures once, in the order they physically appear on the page.
6. Ignore rehearsal letters, tempo marks, and performance notes.

If the page is too degraded to read a passage confidently, transcribe your best
reading rather than omitting the measure — a wrong note is easier for the user
to spot and fix than a missing bar."""


def render_pages(book_name: str, cfg: dict, printed_page: str) -> list[bytes]:
    """PNG bytes for each physical page of this tune's chart."""
    start = fakebooks.pdf_page_for(book_name, cfg, printed_page)
    if start is None:
        raise ValueError(f"{book_name} has no printed page {printed_page}")
    span = fakebooks.span_for(book_name, printed_page)
    doc = fitz.open(str(fakebooks.book_path(cfg)))
    try:
        out = []
        for i in range(start - 1, min(start - 1 + span, doc.page_count)):
            out.append(doc[i].get_pixmap(dpi=RENDER_DPI).tobytes("png"))
        return out
    finally:
        doc.close()


class NotConfigured(RuntimeError):
    """No API credentials available — transcription is switched off, but the
    rest of the app (including already-transcribed charts) still works."""


def transcribe(images: list[bytes], title: str, composer: str | None = None) -> dict:
    """Vision-transcribe a chart's page images into the SCHEMA shape.

    Raises NotConfigured with no credentials, RuntimeError if the model
    declines, ValueError if the page yields nothing usable.
    """
    if not images:
        raise ValueError("no page images to transcribe")

    # The SDK resolves credentials from several places (env var, auth token, a
    # stored profile), so let it decide rather than testing for the env var —
    # it raises TypeError when it can't find any.
    try:
        client = anthropic.Anthropic()
    except (TypeError, anthropic.AnthropicError) as e:
        raise NotConfigured("no Anthropic credentials configured") from e
    content: list[dict] = [
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": base64.standard_b64encode(png).decode(),
            },
        }
        for png in images
    ]
    who = f' by {composer}' if composer else ""
    content.append({
        "type": "text",
        "text": f'Transcribe the lead sheet for "{title}"{who} from '
                f'{"these pages" if len(images) > 1 else "this page"}. '
                f"If more than one tune appears, transcribe only this one.",
    })

    # Streaming: a dense chart can run long, and a non-streaming request at this
    # max_tokens risks an HTTP timeout.
    try:
        with client.messages.stream(
            model=MODEL,
            max_tokens=32000,
            system=SYSTEM,
            thinking={"type": "adaptive"},
            output_config={"effort": "high",
                           "format": {"type": "json_schema", "schema": SCHEMA}},
            messages=[{"role": "user", "content": content}],
        ) as stream:
            message = stream.get_final_message()
    except TypeError as e:  # SDK's "could not resolve authentication method"
        raise NotConfigured("no Anthropic credentials configured") from e
    except anthropic.AuthenticationError as e:
        raise NotConfigured("Anthropic credentials rejected") from e
    except anthropic.APIStatusError as e:
        raise RuntimeError(f"transcription failed ({e.status_code})") from e
    except anthropic.APIConnectionError as e:
        raise RuntimeError("could not reach the transcription service") from e

    if message.stop_reason == "refusal":
        raise RuntimeError("model declined to transcribe this page")
    text = next((b.text for b in message.content if b.type == "text"), None)
    if not text:
        raise ValueError("transcription returned no content")
    data = json.loads(text)
    if not data.get("measures"):
        raise ValueError("transcription found no measures on this page")
    data["_usage"] = {
        "input_tokens": message.usage.input_tokens,
        "output_tokens": message.usage.output_tokens,
    }
    return data
