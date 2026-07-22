"""Flask app: JSON API for Tune Deck + serves the built React SPA.

Picking/filtering happens client-side (instant deck feel, logic lives in the
portable TS core). The server owns persistence: times_picked, last_played_key,
and crowd ratings. See CLAUDE.md.
"""
from __future__ import annotations

import io
import mimetypes
import os
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, jsonify, request, send_file, send_from_directory, session
from flask_compress import Compress
from sqlalchemy import select

# Python guesses .m4a as the obscure "audio/mp4a-latm"; serve the AAC voice
# clips as the broadly-supported audio/mp4 so every browser plays them.
mimetypes.add_type("audio/mp4", ".m4a")
# Some platforms don't map .mjs; a module worker (pdf.js ships one as .mjs) must
# be served with a JS MIME type or the browser refuses to run it.
mimetypes.add_type("text/javascript", ".mjs")

from . import fakebooks
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

# Signed session cookie carries the fake-book auth flag. SECRET_KEY must be set
# in prod (a Fly secret); the dev fallback is fine for local http only. Cookie is
# Secure by default (Fly is https); set TUNEDECK_LOCAL=1 to test auth over local
# http. Year-long so the owner enters the fake-book password just once.
app.secret_key = os.environ.get("SECRET_KEY", "dev-insecure-secret-change-me")
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("TUNEDECK_LOCAL") != "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=365),
)

# gzip JSON/text responses (the /api/tunes payload is ~1.8 MB uncompressed →
# ~250 KB gzipped). flask-compress negotiates via Accept-Encoding automatically.
Compress(app)


@app.after_request
def _cache_headers(resp):
    """Cache policy: hashed build assets forever, everything else revalidated.

    Vite content-hashes files under /assets/, so a new deploy = new URLs — those
    are safe to cache immutably for a year. The HTML shell and API stay
    revalidated so deploys and crowd-rating changes are picked up. Other static
    (icons, covers, card art, audio) changes rarely → a one-day browser cache.
    """
    path = request.path
    if path.startswith("/api/fakebook/") and path.endswith(".pdf"):
        return resp  # keep the PDF route's own (private, cacheable) headers
    if path.startswith("/api/") or path == "/sw.js":
        # SW must revalidate every load so a new worker rolls out promptly.
        resp.headers["Cache-Control"] = "no-cache"
    elif resp.status_code == 200 and path.startswith("/assets/"):
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif resp.mimetype == "text/html":
        resp.headers["Cache-Control"] = "no-cache"
    elif resp.status_code == 200:
        resp.headers["Cache-Control"] = "public, max-age=86400"
    return resp


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
    """User confirms the band actually played this tune. The key it was played in
    (whatever was on screen) becomes last_played_key — this is the ONLY thing that
    updates it; randomizing the key for a view does not."""
    body = request.get_json(silent=True) or {}
    key = (body.get("key") or "").strip() or None
    with SessionLocal() as session:
        tune = session.get(Tune, tune_id)
        if tune is None:
            return jsonify(error="not found"), 404
        tune.times_played += 1
        tune.last_played_at = datetime.now(timezone.utc)
        if key:
            tune.last_played_key = key
        session.commit()
        return jsonify(tune.to_dict())


@app.post("/api/tunes/<tune_id>/key")
def randomize_key(tune_id: str):
    """Generate a random in-mode key for THIS view only. Deliberately does not
    persist — last_played_key changes only when the user marks a tune played."""
    with SessionLocal() as session:
        tune = session.get(Tune, tune_id)
        if tune is None:
            return jsonify(error="not found"), 404
        return jsonify(key=_random_key_in_mode(tune.original_key))


@app.post("/api/tunes/<tune_id>/vote")
def vote(tune_id: str):
    """One swipe/tap: a like/dislike and/or an obscurity/difficulty nudge, written
    as a single rating row (so undo reverts all of it at once). Returns the
    refreshed tune + the rating id."""
    body = request.get_json(silent=True) or {}
    liked = body.get("liked")
    liked = liked if isinstance(liked, bool) else None
    obscurity = _clamp_score(body.get("obscurity"))
    difficulty = _clamp_score(body.get("difficulty"))
    if liked is None and obscurity is None and difficulty is None:
        return jsonify(error="provide liked and/or obscurity/difficulty"), 400

    with SessionLocal() as session:
        tune = session.get(Tune, tune_id)
        if tune is None:
            return jsonify(error="not found"), 404
        rating = TuneRating(
            tune_id=tune.id,
            anonymous_user_id=(body.get("anonymous_user_id") or None),
            liked=liked,
            obscurity_rating=obscurity,
            difficulty_rating=difficulty,
        )
        session.add(rating)
        session.flush()  # assign rating.id
        rating_id = rating.id
        recompute(session, tune)
        session.commit()
        return jsonify(tune=tune.to_dict(), rating_id=rating_id)


@app.delete("/api/ratings/<rating_id>")
def delete_rating(rating_id: str):
    """Undo a swipe: remove the vote and re-aggregate its tune."""
    with SessionLocal() as session:
        rating = session.get(TuneRating, rating_id)
        if rating is None:
            return jsonify(ok=True)  # already gone — idempotent
        tune = session.get(Tune, rating.tune_id)
        session.delete(rating)
        session.flush()
        if tune is not None:
            recompute(session, tune)
        session.commit()
        return jsonify(tune.to_dict() if tune is not None else {"ok": True})


# --------------------------------------------------------------------------- #
# Fake-book reader (private, password-gated). Personal access to the owner's own
# PDFs so a chart ref can open to the tune. See app/fakebooks.py + CLAUDE.md.
# --------------------------------------------------------------------------- #
@app.get("/api/fakebook/meta")
def fakebook_meta():
    """Book slug/offset/availability + whether the caller is already authed."""
    m = fakebooks.meta()
    m["authed"] = bool(session.get("fb"))
    return jsonify(m)


@app.post("/api/fakebook/auth")
def fakebook_auth():
    """Exchange the shared password for a year-long signed session cookie."""
    if not fakebooks.password():
        return jsonify(error="fake-book access not configured"), 503
    body = request.get_json(silent=True) or {}
    if not fakebooks.check_password(body.get("password") or ""):
        return jsonify(error="wrong password"), 403
    session.permanent = True
    session["fb"] = True
    return jsonify(ok=True)


@app.post("/api/fakebook/logout")
def fakebook_logout():
    session.pop("fb", None)
    return jsonify(ok=True)


@app.get("/api/fakebook/<slug>.pdf")
def fakebook_pdf(slug: str):
    """Stream a book PDF (Range-capable, so pdf.js fetches only viewed pages).
    401 without the auth cookie; the bytes never leave the authed session."""
    if not session.get("fb"):
        return jsonify(error="unauthorized"), 401
    found = fakebooks.book_for_slug(slug)
    if not found:
        return jsonify(error="unknown book"), 404
    _name, cfg = found
    path = fakebooks.book_path(cfg)
    if not path.exists():
        return jsonify(error="book unavailable"), 404
    resp = send_file(path, mimetype="application/pdf", conditional=True)
    resp.headers["Accept-Ranges"] = "bytes"
    resp.headers["Cache-Control"] = "private, max-age=86400"
    return resp


@app.get("/api/fakebook/<slug>/tune-p<printed>.pdf")
def fakebook_tune_page(slug: str, printed: str):
    """A one-tune PDF: the pages starting at PRINTED page `printed` (offset +
    span both applied server-side), for handing a single chart to forScore. Small
    enough to skip Range. `printed` is the page as the book prints it, so it may
    carry a section letter ("A1" = Real Book Vol. 1's appendix)."""
    if not session.get("fb"):
        return jsonify(error="unauthorized"), 401
    found = fakebooks.book_for_slug(slug)
    if not found:
        return jsonify(error="unknown book"), 404
    name, cfg = found
    if not fakebooks.book_path(cfg).exists():
        return jsonify(error="book unavailable"), 404
    # 404 rather than clamp: a ref the book can't satisfy (bad index page number,
    # unknown section) must fail visibly, not quietly hand over the wrong chart.
    start = fakebooks.pdf_page_for(name, cfg, printed)
    if start is None:
        return jsonify(error="no such page in this book"), 404
    span = fakebooks.span_for(name, printed)
    data = fakebooks.extract_pages(cfg, start, span)
    resp = send_file(
        io.BytesIO(data),
        mimetype="application/pdf",
        download_name=f"{fakebooks.slug(name)}-p{printed}.pdf",
    )
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp


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
