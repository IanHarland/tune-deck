"""Crowd scoring.

The seed value is only a placeholder shown until a real person rates a tune.
The FIRST user rating becomes the true score outright (the build-time seed gets
no weight), and every rating after that is averaged in. So:

    score = seed                         (no ratings yet)
    score = mean(user_ratings)           (one or more ratings)

This is deliberately not a Bayesian blend with the seed — the owner wants real
ratings to fully own the score, not be diluted by the build-time guess.
"""
from __future__ import annotations

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from .models import Tune, TuneRating


def _blend(seed: float, total: float, n: int) -> float:
    return seed if n == 0 else total / n


def recompute(session: Session, tune: Tune) -> None:
    """Recompute a tune's aggregate scores from its ratings + seed prior."""
    obs_sum, obs_n = _aggregate(session, tune.id, TuneRating.obscurity_rating)
    dif_sum, dif_n = _aggregate(session, tune.id, TuneRating.difficulty_rating)
    likes, total = _like_counts(session, tune.id)

    tune.obscurity_score = _blend(tune.obscurity_seed, obs_sum, obs_n)
    tune.difficulty_score = _blend(tune.difficulty_seed, dif_sum, dif_n)
    tune.obscurity_votes = obs_n
    tune.difficulty_votes = dif_n
    # hipness = like-rate (0–100) with a Bayesian prior of one virtual neutral
    # vote (0.5 like / 0.5 dislike). Every tune starts at a legitimate 50 and a
    # single human swipe only nudges it (1 like → 75, 1 dislike → 25) instead of
    # slamming it to the rail; the prior washes out as real votes accumulate.
    # rating_votes counts REAL swipes only (0 = still on the bare prior).
    tune.rating_score = 100.0 * (likes + 0.5) / (total + 1)
    tune.rating_votes = total


def _like_counts(session: Session, tune_id: str) -> tuple[int, int]:
    """(# likes, # total like/dislike votes) for a tune."""
    row = session.execute(
        select(
            func.count(case((TuneRating.liked.is_(True), 1))),
            func.count(TuneRating.liked),
        ).where(TuneRating.tune_id == tune_id)
    ).one()
    return int(row[0]), int(row[1])


def _aggregate(session: Session, tune_id: str, column) -> tuple[float, int]:
    row = session.execute(
        select(func.coalesce(func.sum(column), 0.0), func.count(column))
        .where(TuneRating.tune_id == tune_id, column.isnot(None))
    ).one()
    return float(row[0]), int(row[1])
