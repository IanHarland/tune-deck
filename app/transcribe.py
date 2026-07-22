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

# Opus 4.8 reads images up to 2576px on the long edge AND ~3.75 MP. 220 dpi
# clears the first but is 4.8 MP, so the page got resampled server-side anyway;
# 200 dpi lands a US-Letter page at ~3.75 MP, keeping the downscale under our
# control (PyMuPDF's resampler) instead of theirs.
RENDER_DPI = 200

# "t" = triplet (three in the time of two). Without these the transcriber has to
# round triplets into straight notes, which destroys the rhythm of most heads.
DURATIONS = ["16", "16t", "8", "8t", "8.", "4", "4t", "4.", "2", "2.", "1"]
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
                        "description": "Chord symbols printed over this measure, in order. "
                                       "Most bars have one. Skip chords printed in "
                                       "parentheses — those are optional substitutions, "
                                       "not the tune's changes.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "root": {
                                    "type": "string",
                                    "description": "Chord root as printed: A-G with an "
                                                   "optional b or # (e.g. 'Bb', 'F#').",
                                },
                                "kind": {"type": "string", "enum": KINDS},
                                "beat": {
                                    "type": "integer",
                                    "description": "Which beat of the measure the chord "
                                                   "sits on, 1-based. A lone chord at the "
                                                   "start of the bar is 1; a second chord "
                                                   "halfway through a 4/4 bar is 3. Getting "
                                                   "this right keeps two chords in one bar "
                                                   "from printing on top of each other.",
                                },
                            },
                            "required": ["root", "kind", "beat"],
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
You transcribe scanned jazz lead sheets into symbolic notation. A musician will
read your output on a gig, so it has to match the printed page bar for bar.

Work measure by measure, left to right and top to bottom. Before moving to the
next measure, verify that measure: durations sum correctly, and the notes you
wrote match the noteheads, stems, flags and beams actually on the page.

Rules, most consequential first:

1. KEY AND TIME SIGNATURE. Read both off the printed staff, not from the
   chords. Everything downstream is transposed relative to the key, so a wrong
   key signature corrupts the entire chart.

2. RHYTHM IS AS IMPORTANT AS PITCH. Read each note's actual duration from its
   appearance — hollow notehead with no stem is a whole note, hollow with a
   stem is a half, filled with a stem is a quarter, one flag or one beam is an
   eighth, two is a sixteenth, a dot adds half again. Do not flatten a busy bar
   into long notes: if the page shows a run of beamed eighth notes, write
   eighth notes. Triplets (a bracketed or slurred 3) use the "t" durations —
   three "8t" fill one beat.

3. DURATIONS MUST SUM. Every measure totals a full bar, except a pickup. In 4/4
   that is four quarter-beats: e.g. 4+4+4+4, or 2+4+4, or 8+8+4+4+4, or
   8t+8t+8t+4+4+4. If your measure does not add up you have misread a duration
   — recount it before moving on. Never pad with rests that are not printed.

4. PITCH SPELLING. Spell pitches as they SOUND under the key signature: a note
   on the middle line under three flats is Bb even with no accidental printed
   beside it. Apply printed accidentals and carry them through the measure.

5. CHORD SYMBOLS. Give each its beat within the bar. Most bars have one chord
   on beat 1; when a bar has two, the second is usually beat 3 in 4/4.
   IGNORE chords printed in parentheses — those are optional reharmonisations,
   not the tune's changes. Also ignore chords belonging to a different staff.

6. PICKUPS. If the tune opens with a partial bar before the first full measure,
   set pickup=true and make that first measure only as long as it is printed.

7. SCOPE. Melody staff only — ignore any second staff of rhythm slashes or a
   sample bass line, and ignore lyrics, rehearsal letters, tempo marks and
   performance notes. If several tunes share the page, transcribe only the one
   you were asked for and stop at its final barline.

8. REPEATS. Transcribe the measures once, in the order they physically appear.
   Do not expand repeat signs, first/second endings, D.S. or coda jumps.

If a passage is too degraded to read confidently, write your best reading rather
than dropping the bar — a wrong note is easier to spot and fix than a missing
one."""


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
    # max_tokens covers thinking AND the answer. At 32k the model spent the
    # whole budget reading the page and emitted nothing (stop_reason
    # max_tokens, zero text blocks) — or, worse, rushed the melody to fit.
    # A dense chart needs room for both; streaming keeps the long request alive.
    try:
        with client.messages.stream(
            model=MODEL,
            max_tokens=64000,
            system=SYSTEM,
            thinking={"type": "adaptive"},
            # Measured on New Real Book p.12 (Autumn Leaves), 64k budget:
            #   high   — ran past 10 min, abandoned
            #   medium — 680 s, $1.30, 33/33 measures, every bar sums  <- chosen
            #   low    — 379 s, $0.76, only 20 measures (truncated)
            # Low is not a cheaper version of the same answer; it silently drops
            # bars, which is the failure that made the first charts unusable.
            output_config={"effort": "medium",
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
    if message.stop_reason == "max_tokens":
        # Distinguish this loudly: it means the budget was too small for the
        # page, not that the page was unreadable. Silently accepting a
        # truncated answer is how you get a chart that's missing its last bars.
        raise RuntimeError(
            f"ran out of output budget on this chart "
            f"({message.usage.output_tokens:,} tokens) — the transcription "
            f"would be incomplete")
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
