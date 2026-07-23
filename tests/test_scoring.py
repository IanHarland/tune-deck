"""app/scoring.py — how crowd ratings become the displayed score.

Two different rules live here and they're easy to confuse:
  * obscurity/difficulty — the FIRST real vote REPLACES the build-time seed
    outright (no blend), then votes average.
  * hipness — a Bayesian prior of one virtual neutral vote, so a single swipe
    nudges (75/25) instead of slamming to the rail.
"""
from __future__ import annotations

import pytest

from app import scoring
from app.models import TuneRating


def rate(session, tune, **kw):
    session.add(TuneRating(tune_id=tune.id, **kw))
    session.commit()
    scoring.recompute(session, tune)
    session.commit()


# --------------------------------------------------------------------------- #
# _blend
# --------------------------------------------------------------------------- #
def test_blend_with_no_votes_is_the_seed():
    assert scoring._blend(40.0, 0.0, 0) == 40.0


def test_blend_ignores_the_seed_once_voted():
    """Deliberately NOT Bayesian: the owner wants real ratings to fully own the
    score, not be diluted by the build-time guess."""
    assert scoring._blend(40.0, 90.0, 1) == 90.0


def test_blend_averages_multiple_votes():
    assert scoring._blend(40.0, 150.0, 2) == 75.0


# --------------------------------------------------------------------------- #
# obscurity / difficulty
# --------------------------------------------------------------------------- #
def test_unvoted_tune_keeps_its_seed(session, make_tune):
    t = make_tune(obscurity_seed=12.0, difficulty_seed=30.0)
    scoring.recompute(session, t)
    assert t.obscurity_score == 12.0
    assert t.difficulty_score == 30.0
    assert t.obscurity_votes == 0


def test_first_vote_replaces_the_seed_outright(session, make_tune):
    t = make_tune(obscurity_seed=4.0)
    rate(session, t, obscurity_rating=90.0)
    assert t.obscurity_score == 90.0
    assert t.obscurity_votes == 1


def test_votes_average_thereafter(session, make_tune):
    t = make_tune(obscurity_seed=4.0)
    rate(session, t, obscurity_rating=80.0)
    rate(session, t, obscurity_rating=60.0)
    assert t.obscurity_score == 70.0
    assert t.obscurity_votes == 2


def test_obscurity_and_difficulty_are_counted_independently(session, make_tune):
    """A vote on one slider must not count as a vote on the other."""
    t = make_tune(obscurity_seed=4.0, difficulty_seed=26.0)
    rate(session, t, obscurity_rating=90.0)
    assert t.obscurity_votes == 1 and t.obscurity_score == 90.0
    assert t.difficulty_votes == 0 and t.difficulty_score == 26.0


def test_ratings_for_other_tunes_do_not_leak(session, make_tune):
    a = make_tune("Autumn Leaves", obscurity_seed=4.0)
    b = make_tune("Giant Steps", obscurity_seed=50.0)
    rate(session, a, obscurity_rating=99.0)
    scoring.recompute(session, b)
    assert b.obscurity_score == 50.0 and b.obscurity_votes == 0


# --------------------------------------------------------------------------- #
# hipness — Bayesian prior of one neutral vote
# --------------------------------------------------------------------------- #
def test_unrated_hipness_is_a_legitimate_50(session, make_tune):
    t = make_tune()
    scoring.recompute(session, t)
    assert t.rating_score == 50.0
    assert t.rating_votes == 0


def test_one_like_nudges_to_75_not_100(session, make_tune):
    """(1 + 0.5) / (1 + 1) = 75. A single swipe shouldn't slam the rail."""
    t = make_tune()
    rate(session, t, liked=True)
    assert t.rating_score == 75.0
    assert t.rating_votes == 1


def test_one_dislike_nudges_to_25_not_0(session, make_tune):
    t = make_tune()
    rate(session, t, liked=False)
    assert t.rating_score == 25.0


def test_the_prior_washes_out_as_votes_accumulate(session, make_tune):
    t = make_tune()
    for _ in range(20):
        rate(session, t, liked=True)
    assert t.rating_score > 95.0
    assert t.rating_votes == 20


def test_mixed_votes_land_near_the_like_rate(session, make_tune):
    t = make_tune()
    for _ in range(5):
        rate(session, t, liked=True)
    for _ in range(5):
        rate(session, t, liked=False)
    assert t.rating_score == pytest.approx(50.0, abs=1.0)


def test_rating_votes_counts_only_real_swipes(session, make_tune):
    """A slider-only vote carries liked=None and must not inflate rating_votes,
    or an unrated tune would look rated to the hipness picker."""
    t = make_tune()
    rate(session, t, obscurity_rating=70.0)
    assert t.rating_votes == 0
    assert t.rating_score == 50.0
