"""app/web.py — the JSON API.

Two themes carry most of the weight:
  * the PRIVACY boundary — the public payload must never carry chart content,
    and every private route must 401 without the session cookie;
  * the 404-don't-guess rule — a ref a book can't satisfy must fail visibly
    rather than quietly handing over the wrong chart.
"""
from __future__ import annotations

import json

import pytest

from app.models import TuneRating


# --------------------------------------------------------------------------- #
# Health / meta
# --------------------------------------------------------------------------- #
def test_health(client):
    assert client.get("/api/health").get_json() == {"status": "ok"}


def test_healthz_is_plain_text_for_fly(client):
    r = client.get("/api/healthz")
    assert r.status_code == 200 and r.data == b"ok"


def test_meta_lists_feels_and_keys(client):
    body = client.get("/api/meta").get_json()
    assert set(body["feels"]) >= {"ballad", "medium_swing", "up", "latin", "waltz"}
    assert len(body["keys"]) == 12


# --------------------------------------------------------------------------- #
# /api/tunes
# --------------------------------------------------------------------------- #
def test_list_tunes_empty(client):
    assert client.get("/api/tunes").get_json() == []


def test_list_tunes(client, api_tune):
    api_tune("Autumn Leaves")
    api_tune("Giant Steps")
    titles = {t["title"] for t in client.get("/api/tunes").get_json()}
    assert titles == {"Autumn Leaves", "Giant Steps"}


def test_list_tunes_hides_deleted(client, api_tune):
    api_tune("Autumn Leaves")
    api_tune("Blues - Minor", deleted=True)
    titles = {t["title"] for t in client.get("/api/tunes").get_json()}
    assert titles == {"Autumn Leaves"}


def test_public_payload_carries_no_chart_content(client, api_tune):
    """The app never ships copyrighted chart content publicly — metadata only.
    A regression here would put melodies in an unauthenticated response."""
    api_tune("Autumn Leaves", charts=[{"book": "Jazz LTD", "page": "12"}])
    row = client.get("/api/tunes").get_json()[0]
    assert "musicxml" not in json.dumps(row).lower()
    assert set(row["charts"][0]) <= {"book", "page"}


def test_public_payload_shape(client, api_tune):
    api_tune()
    row = client.get("/api/tunes").get_json()[0]
    for field in ("id", "title", "composer", "original_key", "feel",
                  "obscurity_score", "difficulty_score", "rating_score", "tags"):
        assert field in row


# --------------------------------------------------------------------------- #
# Voting
# --------------------------------------------------------------------------- #
def test_vote_like(client, api_tune):
    t = api_tune()
    body = client.post(f"/api/tunes/{t.id}/vote", json={"liked": True}).get_json()
    assert body["tune"]["rating_score"] == 75.0
    assert body["rating_id"]


def test_vote_sliders(client, api_tune):
    t = api_tune(obscurity_seed=4.0)
    body = client.post(f"/api/tunes/{t.id}/vote",
                       json={"obscurity": 80, "difficulty": 60}).get_json()
    assert body["tune"]["obscurity_score"] == 80.0
    assert body["tune"]["difficulty_score"] == 60.0


def test_vote_writes_one_row_for_a_combined_swipe(client, api_tune):
    """Like + nudges are a single rating row so undo reverts all of it at once."""
    t = api_tune()
    client.post(f"/api/tunes/{t.id}/vote",
                json={"liked": True, "obscurity": 70, "difficulty": 40})
    with client.Session() as s:
        assert s.query(TuneRating).count() == 1


def test_empty_vote_is_rejected(client, api_tune):
    t = api_tune()
    assert client.post(f"/api/tunes/{t.id}/vote", json={}).status_code == 400


def test_vote_on_unknown_tune_404s(client):
    assert client.post("/api/tunes/nope/vote", json={"liked": True}).status_code == 404


@pytest.mark.parametrize("sent,stored", [(150, 100), (-20, 0), (50, 50)])
def test_vote_scores_are_clamped(client, api_tune, sent, stored):
    t = api_tune()
    body = client.post(f"/api/tunes/{t.id}/vote", json={"obscurity": sent}).get_json()
    assert body["tune"]["obscurity_score"] == stored


def test_non_boolean_liked_is_ignored(client, api_tune):
    """A junk `liked` must not be counted as a swipe."""
    t = api_tune()
    body = client.post(f"/api/tunes/{t.id}/vote",
                       json={"liked": "yes", "obscurity": 50}).get_json()
    assert body["tune"]["rating_votes"] == 0


# --------------------------------------------------------------------------- #
# Undo
# --------------------------------------------------------------------------- #
def test_undo_removes_the_rating_and_reverts_the_score(client, api_tune):
    t = api_tune(obscurity_seed=4.0)
    rating_id = client.post(f"/api/tunes/{t.id}/vote",
                            json={"obscurity": 90}).get_json()["rating_id"]
    reverted = client.delete(f"/api/ratings/{rating_id}").get_json()
    assert reverted["obscurity_score"] == 4.0   # back to the seed
    assert reverted["obscurity_votes"] == 0


def test_undo_is_idempotent(client):
    """Undo may be retried; a missing rating is not an error."""
    assert client.delete("/api/ratings/already-gone").status_code == 200


# --------------------------------------------------------------------------- #
# Picks / played / key
# --------------------------------------------------------------------------- #
def test_pick_increments_the_counter(client, api_tune):
    t = api_tune()
    client.post(f"/api/tunes/{t.id}/pick")
    client.post(f"/api/tunes/{t.id}/pick")
    with client.Session() as s:
        from app.models import Tune
        assert s.get(Tune, t.id).times_picked == 2


def test_randomize_key_stays_in_mode(client, api_tune):
    """A minor tune randomizes to a minor key — never "Db minor"."""
    t = api_tune(original_key="G-")
    for _ in range(20):
        key = client.post(f"/api/tunes/{t.id}/key").get_json()["key"]
        assert key.endswith("-"), key
        assert key[:-1] in ["C", "C#", "D", "Eb", "E", "F",
                            "F#", "G", "G#", "A", "Bb", "B"]


def test_randomize_key_major(client, api_tune):
    t = api_tune(original_key="Bb")
    for _ in range(20):
        key = client.post(f"/api/tunes/{t.id}/key").get_json()["key"]
        assert key in ["C", "Db", "D", "Eb", "E", "F",
                       "Gb", "G", "Ab", "A", "Bb", "B"]


def test_randomize_key_does_not_persist(client, api_tune):
    """last_played_key changes only when the user marks a tune PLAYED — so a
    stale randomization never becomes the headline on a tune nobody played."""
    from app.models import Tune

    t = api_tune(original_key="Bb")
    client.post(f"/api/tunes/{t.id}/key")
    with client.Session() as s:
        assert s.get(Tune, t.id).last_played_key is None


def test_randomize_key_unknown_tune_404s(client):
    assert client.post("/api/tunes/nope/key").status_code == 404


def test_delete_tune_soft_deletes(client, api_tune):
    t = api_tune()
    assert client.delete(f"/api/tunes/{t.id}").status_code == 200
    assert client.get("/api/tunes").get_json() == []


# --------------------------------------------------------------------------- #
# Fake-book gate
# --------------------------------------------------------------------------- #
def test_fakebook_meta_is_public_but_says_unconfigured(client, monkeypatch):
    """The meta route is open (the UI needs it to decide what to render) but
    must not leak anything when no password is set."""
    monkeypatch.delenv("FAKEBOOK_PASSWORD", raising=False)
    body = client.get("/api/fakebook/meta").get_json()
    assert body["configured"] is False and body["authed"] is False


def test_fakebook_auth_rejects_a_wrong_password(client, monkeypatch):
    monkeypatch.setenv("FAKEBOOK_PASSWORD", "hunter2")
    assert client.post("/api/fakebook/auth", json={"password": "nope"}).status_code == 403


def test_fakebook_auth_without_a_password_configured(client, monkeypatch):
    monkeypatch.delenv("FAKEBOOK_PASSWORD", raising=False)
    assert client.post("/api/fakebook/auth", json={"password": "x"}).status_code == 503


def test_fakebook_auth_sets_the_session(client, monkeypatch):
    monkeypatch.setenv("FAKEBOOK_PASSWORD", "hunter2")
    assert client.post("/api/fakebook/auth", json={"password": "hunter2"}).status_code == 200
    with client.session_transaction() as s:
        assert s.get("fb") is True


def test_logout_clears_the_session(client, monkeypatch):
    monkeypatch.setenv("FAKEBOOK_PASSWORD", "hunter2")
    client.post("/api/fakebook/auth", json={"password": "hunter2"})
    client.post("/api/fakebook/logout")
    with client.session_transaction() as s:
        assert not s.get("fb")


def test_tune_pdf_requires_auth(client):
    r = client.get("/api/fakebook/the-real-book-vol-1/tune-p100.pdf")
    assert r.status_code == 401


def test_tune_pdf_unknown_book_404s(authed_client):
    assert authed_client.get("/api/fakebook/not-a-book/tune-p1.pdf").status_code == 404


def test_tune_pdf_unavailable_book_404s(authed_client):
    """Tests run with an empty books dir — an absent PDF must 404, not 500."""
    assert authed_client.get(
        "/api/fakebook/the-real-book-vol-1/tune-p100.pdf").status_code == 404


def test_tune_pdf_unstocked_edition_404s_rather_than_falling_back(authed_client):
    """A horn player must never get concert pitch while believing they asked
    for E♭ — Vol. 3 has a B♭ printing but no E♭ one."""
    r = authed_client.get("/api/fakebook/the-real-book-vol-3/tune-p150.pdf?edition=Eb")
    assert r.status_code == 404
    assert "Eb" in r.get_json()["error"]


# --------------------------------------------------------------------------- #
# Notation gate
# --------------------------------------------------------------------------- #
def test_notation_index_requires_auth(client):
    r = client.get("/api/notation/tunes")
    assert r.status_code == 401
    assert r.get_json() == {"tunes": []}   # and enumerates nothing


def test_notation_index_when_authed(authed_client):
    assert authed_client.get("/api/notation/tunes").get_json() == {"tunes": []}


def test_notation_index_lists_tunes_with_charts(authed_client, api_tune):
    from app.models import TuneTranscription

    t = api_tune(charts=[{"book": "Jazz LTD", "page": "5"}])
    with authed_client.Session() as s:
        s.add(TuneTranscription(tune_id=t.id, book="Jazz LTD", printed_page="5",
                                musicxml="<score/>", source_key="G-"))
        s.commit()
    assert authed_client.get("/api/notation/tunes").get_json()["tunes"] == [t.id]


def test_notation_meta_never_returns_musicxml(client, api_tune):
    """to_dict() on a transcription must not carry the chart itself — this route
    is reachable without the cookie."""
    from app.models import TuneTranscription

    t = api_tune(charts=[{"book": "Jazz LTD", "page": "5"}])
    with client.Session() as s:
        s.add(TuneTranscription(tune_id=t.id, book="Jazz LTD", printed_page="5",
                                musicxml="<score>SECRET</score>", source_key="G-"))
        s.commit()
    body = client.get(f"/api/chart/{t.id}/notation").get_json()
    assert "SECRET" not in json.dumps(body)
    assert "musicxml" not in json.dumps(body)


def test_notation_meta_unknown_tune_404s(client):
    assert client.get("/api/chart/nope/notation").status_code == 404


def test_notation_meta_offers_keys_in_the_right_mode(client, api_tune):
    t = api_tune(original_key="G-")
    keys = client.get(f"/api/chart/{t.id}/notation").get_json()["keys"]
    assert "C#" in keys and "Db" not in keys   # minor spellings


def test_notation_svg_requires_auth(client, api_tune):
    t = api_tune()
    assert client.get(f"/api/chart/{t.id}/notation.svg").status_code in (401, 404)


def test_notation_musicxml_requires_auth(client, api_tune):
    t = api_tune()
    assert client.get(f"/api/chart/{t.id}/notation.musicxml").status_code in (401, 404)


def test_font_css_is_served(client):
    """Without it, chord-symbol accidentals render as tofu boxes."""
    r = client.get("/api/notation/font.css")
    assert r.status_code == 200
    assert "font-face" in r.get_data(as_text=True).lower()


# --------------------------------------------------------------------------- #
# There is deliberately no write API for charts
# --------------------------------------------------------------------------- #
def test_no_chart_upload_endpoint(authed_client, api_tune):
    """The charts/ folder is the only way in — no upload UI, no write API."""
    t = api_tune()
    r = authed_client.post(f"/api/chart/{t.id}/notation", json={})
    assert r.status_code in (404, 405)


def test_no_chart_delete_endpoint(authed_client, api_tune):
    t = api_tune()
    r = authed_client.delete(f"/api/chart/{t.id}/notation")
    assert r.status_code in (404, 405)
