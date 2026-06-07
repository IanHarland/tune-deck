"""Crowd-weighted scoring.

Users don't set an absolute score; they weigh in. The displayed score is a
Bayesian blend of the seed prior with all user votes:

    score = (PRIOR_WEIGHT * seed + sum(user_votes)) / (PRIOR_WEIGHT + n_votes)

The seed prior is deliberately light (a few pseudo-votes) so that once real
people rate a tune, the crowd dominates — "if a lot of users say it's hard,
it's hard." See CLAUDE.md.
"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .models import Tune, TuneRating

# How many pseudo-votes the seed value is worth. Low on purpose.
PRIOR_WEIGHT = 3


def _blend(seed: float, total: float, n: int) -> float:
    return (PRIOR_WEIGHT * seed + total) / (PRIOR_WEIGHT + n)


def recompute(session: Session, tune: Tune) -> None:
    """Recompute a tune's aggregate scores from its ratings + seed prior."""
    obs_sum, obs_n = _aggregate(session, tune.id, TuneRating.obscurity_rating)
    dif_sum, dif_n = _aggregate(session, tune.id, TuneRating.difficulty_rating)

    tune.obscurity_score = _blend(tune.obscurity_seed, obs_sum, obs_n)
    tune.difficulty_score = _blend(tune.difficulty_seed, dif_sum, dif_n)
    tune.obscurity_votes = obs_n
    tune.difficulty_votes = dif_n


def _aggregate(session: Session, tune_id: str, column) -> tuple[float, int]:
    row = session.execute(
        select(func.coalesce(func.sum(column), 0.0), func.count(column))
        .where(TuneRating.tune_id == tune_id, column.isnot(None))
    ).one()
    return float(row[0]), int(row[1])
