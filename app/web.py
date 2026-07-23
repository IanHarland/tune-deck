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

from . import fakebooks, notation
from .db import SessionLocal, init_db
from .models import FEELS, Tune, TuneRating, TuneTranscription
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
    if path.startswith("/api/notation/") or path.startswith("/api/chart/"):
        return resp  # engraved SVG + music font set their own long-lived caching
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
    carry a section letter ("A1" = Real Book Vol. 1's appendix).

    ?edition=Bb|Eb serves the transposed printing of the same book instead. The
    printed page ref is unchanged — those editions are page-aligned with the
    concert one, which is the only reason this is safe (see fakebooks.BOOKS).
    An edition this book doesn't stock 404s rather than falling back, so a horn
    player never gets concert pitch while believing they asked for B♭.
    """
    if not session.get("fb"):
        return jsonify(error="unauthorized"), 401
    found = fakebooks.book_for_slug(slug)
    if not found:
        return jsonify(error="unknown book"), 404
    name, cfg = found
    edition = (request.args.get("edition") or "").strip() or None
    ed_cfg = fakebooks.edition_cfg(cfg, edition)
    if ed_cfg is None:
        return jsonify(error=f"no {edition} edition of this book"), 404
    if not fakebooks.book_path(ed_cfg).exists():
        return jsonify(error="book unavailable"), 404
    # 404 rather than clamp: a ref the book can't satisfy (bad index page number,
    # unknown section) must fail visibly, not quietly hand over the wrong chart.
    start = fakebooks.pdf_page_for(name, cfg, printed, edition)
    if start is None:
        return jsonify(error="no such page in this book"), 404
    # Span comes from the concert index; the transposed printings share its
    # pagination, so the same tune occupies the same run of printed pages.
    span = fakebooks.span_for(name, printed)
    data = fakebooks.extract_pages(ed_cfg, start, span)
    suffix = f"-{edition}" if ed_cfg is not cfg else ""
    resp = send_file(
        io.BytesIO(data),
        mimetype="application/pdf",
        download_name=f"{fakebooks.slug(name)}-p{printed}{suffix}.pdf",
    )
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp


# --------------------------------------------------------------------------- #
# Static SPA (built by Vite into frontend/dist)
# --------------------------------------------------------------------------- #
# --- Transposable notation ---------------------------------------------- #
# A chart is imported ONCE as MusicXML (scanned in Soundslice and corrected by
# hand, see notation_import), then transposed + engraved on demand — so all 12
# keys come from that single stored copy. Same gate as the fake-book reader:
# this is derived from the owner's own books, so it never leaves the authed
# session.


def _pick_chart(tune: Tune, book: str | None, page: str | None) -> tuple[str, str] | None:
    """Which chart this is notation for: the requested one, else the first whose book
    is actually present and whose page we can locate."""
    charts = tune.charts or []
    for c in charts:
        if book and c.get("book") != book:
            continue
        if page and str(c.get("page")) != str(page):
            continue
        found = fakebooks.book_for_slug(fakebooks.slug(c.get("book") or ""))
        if not found:
            continue
        name, cfg = found
        if not fakebooks.book_path(cfg).exists():
            continue
        if fakebooks.pdf_page_for(name, cfg, c.get("page")) is None:
            continue
        return name, str(c.get("page"))
    return None


def _transcription_for(session, tune_id: str, book: str | None, page: str | None):
    """(tune, transcription|None, (book,page)|None) for this tune.

    With no explicit book/page, an EXISTING transcription wins over the
    first-available chart. A tune is typically in several books, and
    _pick_chart's order comes from the seed, not from preference — without this
    a tune imported from one book would report "not imported" because the
    picker happened to land on a different one.
    """
    tune = session.get(Tune, tune_id)
    if tune is None:
        return None, None, None

    if not book and not page:
        existing = session.execute(
            select(TuneTranscription)
            .where(TuneTranscription.tune_id == tune_id)
            .order_by(TuneTranscription.verified.desc(),
                      TuneTranscription.updated_at.desc())
        ).scalars().first()
        if existing is not None:
            return tune, existing, (existing.book, existing.printed_page)

    chart = _pick_chart(tune, book, page)
    if chart is None:
        return tune, None, None
    row = session.execute(
        select(TuneTranscription).where(
            TuneTranscription.tune_id == tune_id,
            TuneTranscription.book == chart[0],
            TuneTranscription.printed_page == chart[1],
        )
    ).scalar_one_or_none()
    return tune, row, chart


@app.get("/api/notation/font.css")
def notation_font():
    """Verovio's Leipzig @font-face CSS. Engraved SVGs reference it by name
    instead of inlining 58 KB of base64 font apiece, so this is fetched once and
    cached; without it chord-symbol accidentals render as tofu boxes."""
    return send_file(
        notation.font_css_path(), mimetype="text/css", conditional=True,
        max_age=31536000,
    )


@app.get("/api/chart/<tune_id>/notation")
def notation_meta(tune_id: str):
    """Has a chart been imported for this tune, and into which keys can it go?"""
    with SessionLocal() as db:
        tune, row, chart = _transcription_for(
            db, tune_id, request.args.get("book"), request.args.get("page"))
        if tune is None:
            return jsonify(error="not found"), 404
        return jsonify(
            configured=fakebooks.password() is not None,
            authed=bool(session.get("fb")),
            chart={"book": chart[0], "page": chart[1]} if chart else None,
            transcription=row.to_dict() if row else None,
            keys=notation.keys_for(row.source_key if row else tune.original_key),
        )


MAX_MUSICXML_BYTES = 4 * 1024 * 1024  # a dense chart is ~40 KB; 4 MB is generous


@app.post("/api/chart/<tune_id>/notation")
def notation_import(tune_id: str):
    """Store a MusicXML chart for this tune (multipart, field `file`).

    The file comes from scanning the page in Soundslice and fixing whatever the
    scanner got wrong, so it lands `verified=True` — a human has already read it
    against the book. Re-importing the same chart replaces it.

    Machine transcription used to live here (a vision model read the scan). It
    was removed 2026-07-23: measured against the page it got roughly half the
    melody right, at ~$1.30 and ~11 minutes a chart, and "wrong in a way that
    looks right" is the worst possible failure for something you read on a gig.
    """
    if not session.get("fb"):
        return jsonify(error="unauthorized"), 401

    upload = request.files.get("file")
    if upload is None:
        return jsonify(error="no file uploaded"), 400
    data = upload.read(MAX_MUSICXML_BYTES + 1)
    if len(data) > MAX_MUSICXML_BYTES:
        return jsonify(error="that file is too big to be a lead sheet"), 413
    if not data:
        return jsonify(error="that file is empty"), 400

    with SessionLocal() as db:
        tune, row, chart = _transcription_for(
            db, tune_id, request.args.get("book"), request.args.get("page"))
        if tune is None:
            return jsonify(error="not found"), 404
        if chart is None:
            return jsonify(error="no chart reference for this tune"), 404

        try:
            musicxml = notation.sanitize_musicxml(data)
            src = notation.key_name_from_fifths(
                notation.fifths_of(musicxml),
                minor=notation.is_minor(tune.original_key))
            # Prove it engraves in every key the UI will offer BEFORE storing it.
            # Runs out-of-process: Verovio can segfault on input it dislikes, and
            # in-process that would kill the worker mid-request.
            notation.check_renderable(
                musicxml,
                [notation.interval_name(src, k) or "" for k in notation.keys_for(src)])
        except notation.BadMusicXml as e:
            return jsonify(error=str(e)), 422

        book, page = chart
        if row is None:
            row = TuneTranscription(tune_id=tune_id, book=book, printed_page=page)
            db.add(row)
        row.musicxml = musicxml
        row.source_key = src
        row.model = (request.form.get("source") or "import").strip()[:64]
        row.verified = True
        db.commit()
        return jsonify(transcription=row.to_dict(), cached=False)


@app.delete("/api/chart/<tune_id>/notation")
def notation_delete(tune_id: str):
    """Drop a stored chart, so a better export can be imported in its place."""
    if not session.get("fb"):
        return jsonify(error="unauthorized"), 401
    with SessionLocal() as db:
        _tune, row, _chart = _transcription_for(
            db, tune_id, request.args.get("book"), request.args.get("page"))
        if row is None:
            return jsonify(error="not imported yet"), 404
        db.delete(row)
        db.commit()
        return jsonify(ok=True)


@app.get("/api/chart/<tune_id>/notation.svg")
def notation_svg(tune_id: str):
    """The chart engraved in `key` (defaults to the key it was printed in)."""
    if not session.get("fb"):
        return jsonify(error="unauthorized"), 401
    try:
        width = max(600, min(4000, int(request.args.get("width", 2100))))
    except (TypeError, ValueError):
        width = 2100
    with SessionLocal() as db:
        _tune, row, _chart = _transcription_for(
            db, tune_id, request.args.get("book"), request.args.get("page"))
        if row is None:
            return jsonify(error="not imported yet"), 404
        target = (request.args.get("key") or "").strip() or row.source_key
        interval = notation.interval_name(row.source_key or "C", target or "C")
        if interval is None:
            return jsonify(error=f"cannot transpose {row.source_key} -> {target}"), 400
        try:
            svg = notation.render_svg(row.musicxml, transpose=interval or None, width=width)
        except ValueError as e:
            return jsonify(error=str(e)), 500
        resp = app.response_class(svg, mimetype="image/svg+xml")
        # Varies only with (stored revision, key, width); a re-import bumps
        # updated_at, so the ETag tracks the content it describes.
        stamp = int(row.updated_at.timestamp()) if row.updated_at else 0
        resp.headers["ETag"] = f'W/"{row.id}-{stamp}-{target}-{width}"'
        resp.headers["Cache-Control"] = "private, max-age=86400"
        return resp


@app.get("/api/chart/<tune_id>/notation.musicxml")
def notation_musicxml(tune_id: str):
    """The transposed MusicXML itself, for opening in MuseScore/Sibelius."""
    if not session.get("fb"):
        return jsonify(error="unauthorized"), 401
    with SessionLocal() as db:
        tune, row, _chart = _transcription_for(
            db, tune_id, request.args.get("book"), request.args.get("page"))
        if row is None:
            return jsonify(error="not imported yet"), 404
        target = (request.args.get("key") or "").strip() or row.source_key
        interval = notation.interval_name(row.source_key or "C", target or "C")
        if interval is None:
            return jsonify(error=f"cannot transpose {row.source_key} -> {target}"), 400
        try:
            xml = notation.transpose_musicxml(row.musicxml, interval)
        except ValueError as e:
            return jsonify(error=str(e)), 500
        resp = send_file(
            io.BytesIO(xml.encode()), mimetype="application/vnd.recordare.musicxml+xml",
            download_name=f"{tune.title} ({target}).musicxml", as_attachment=False)
        resp.headers["Cache-Control"] = "private, max-age=86400"
        return resp


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
