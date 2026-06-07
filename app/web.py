"""Flask app: JSON API for Tune Deck + serves the built React SPA.

Picking/filtering happens client-side (instant deck feel, logic lives in the
portable TS core). The server owns persistence: times_picked, last_played_key,
and crowd ratings. See CLAUDE.md.
"""
from __future__ import annotations

import mimetypes
import random
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from sqlalchemy import select

# Python guesses .m4a as the obscure "audio/mp4a-latm"; serve the AAC voice
# clips as the broadly-supported audio/mp4 so every browser plays them.
mimetypes.add_type("audio/mp4", ".m4a")

from .db import SessionLocal, init_db
from .models import FEELS, Tune, TuneRating
from .scoring import recompute

# A tune is randomized within its OWN mode (major/minor), so the 24-key space is
# respected without breaking the tune: a minor tune gets a random minor key, a
# major tune a random major key. Quality comes from the tune's original_key
# (iReal notation: "G-" = minor, "Bb" = major).
#
# Enharmonic spelling follows the conventional (fewest-accidentals) key
# signature for each mode — so major uses Db/Gb/Ab while minor uses C#/F#/G#
# (no one writes "Db minor"; it's C# minor).
MAJOR_KEYS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
MINOR_KEYS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "G#", "A", "Bb", "B"]
KEYS = MAJOR_KEYS  # exposed via /api/meta for reference


def _is_minor(key: str | None) -> bool:
    if not key:
        return False
    k = key.strip().lower()
    return k.endswith("-") or k.endswith("m") or "min" in k


def _random_key_in_mode(original_key: str | None) -> str:
    if _is_minor(original_key):
        return f"{random.choice(MINOR_KEYS)}-"
    return random.choice(MAJOR_KEYS)

FRONTEND_DIST = Path(__file__).resolve().parent.parent / "frontend" / "dist"

app = Flask(__name__, static_folder=None)


def _clamp_score(v) -> float | None:
    if v is None:
        return None
    try:
        return max(0.0, min(100.0, float(v)))
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# API
# --------------------------------------------------------------------------- #
@app.get("/api/health")
def health():
    return jsonify(status="ok")


@app.get("/api/healthz")  # Fly health check
def healthz():
    return "ok", 200


@app.get("/api/meta")
def meta():
    """Static config the client needs (feels, keys)."""
    return jsonify(feels=FEELS, keys=KEYS)


@app.get("/api/tunes")
def list_tunes():
    """All (non-deleted) tunes. The client filters + picks locally."""
    with SessionLocal() as session:
        tunes = (
            session.execute(select(Tune).where(Tune.deleted.is_(False)))
            .scalars()
            .all()
        )
        return jsonify([t.to_dict() for t in tunes])


@app.delete("/api/tunes/<tune_id>")
def delete_tune(tune_id: str):
    """Soft-delete a tune (e.g. an exercise junk-imported from iReal). The row
    is kept as a tombstone so re-seeding won't bring it back."""
    with SessionLocal() as session:
        tune = session.get(Tune, tune_id)
        if tune is None:
            return jsonify(error="not found"), 404
        tune.deleted = True
        session.commit()
        return jsonify(ok=True)


@app.post("/api/tunes/<tune_id>/pick")
def pick(tune_id: str):
    """Record that a tune was drawn from the deck."""
    with SessionLocal() as session:
        tune = session.get(Tune, tune_id)
        if tune is None:
            return jsonify(error="not found"), 404
        tune.times_picked += 1
        tune.last_picked_at = datetime.now(timezone.utc)
        session.commit()
        return jsonify(tune.to_dict())


@app.post("/api/tunes/<tune_id>/played")
def played(tune_id: str):
    """User confirms the band actually played this tune."""
    with SessionLocal() as session:
        tune = session.get(Tune, tune_id)
        if tune is None:
            return jsonify(error="not found"), 404
        tune.times_played += 1
        tune.last_played_at = datetime.now(timezone.utc)
        session.commit()
        return jsonify(tune.to_dict())


@app.post("/api/tunes/<tune_id>/key")
def randomize_key(tune_id: str):
    """Pick a random chromatic root, persist as last_played_key, return it."""
    with SessionLocal() as session:
        tune = session.get(Tune, tune_id)
        if tune is None:
            return jsonify(error="not found"), 404
        new_key = _random_key_in_mode(tune.original_key)
        tune.last_played_key = new_key
        session.commit()
        return jsonify(last_played_key=new_key)


@app.post("/api/tunes/<tune_id>/rate")
def rate(tune_id: str):
    """Submit a crowd weigh-in and return the tune with refreshed aggregates."""
    body = request.get_json(silent=True) or {}
    obscurity = _clamp_score(body.get("obscurity"))
    difficulty = _clamp_score(body.get("difficulty"))
    if obscurity is None and difficulty is None:
        return jsonify(error="provide obscurity and/or difficulty"), 400

    with SessionLocal() as session:
        tune = session.get(Tune, tune_id)
        if tune is None:
            return jsonify(error="not found"), 404
        session.add(TuneRating(
            tune_id=tune.id,
            anonymous_user_id=(body.get("anonymous_user_id") or None),
            obscurity_rating=obscurity,
            difficulty_rating=difficulty,
        ))
        recompute(session, tune)
        session.commit()
        return jsonify(tune.to_dict())


# --------------------------------------------------------------------------- #
# Static SPA (built by Vite into frontend/dist)
# --------------------------------------------------------------------------- #
@app.get("/")
def index():
    if (FRONTEND_DIST / "index.html").exists():
        return send_from_directory(FRONTEND_DIST, "index.html")
    return jsonify(status="api-only", hint="build the frontend (npm run build)"), 200


@app.get("/<path:path>")
def static_proxy(path: str):
    target = FRONTEND_DIST / path
    if target.exists() and target.is_file():
        return send_from_directory(FRONTEND_DIST, path)
    # SPA fallback
    if (FRONTEND_DIST / "index.html").exists():
        return send_from_directory(FRONTEND_DIST, "index.html")
    return jsonify(error="not found"), 404


# Initialize on import so gunicorn workers are ready.
init_db()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, debug=True)
