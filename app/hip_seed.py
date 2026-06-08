"""Seed hipness (5★) votes from data/hip_seeds.py so ratings start with a
sensible backbone instead of an empty slate.

The lists rank tunes by "hipness". Nested tiers map to a target star value; a
tune's target is the mean of the tiers it appears in (so deeper-nested = more
extreme, and a tune contested between hip/not-hip lands in the middle). We then
insert integer star votes that average to that target. The number of votes
scales with how many lists a tune is in (more lists ⇒ more confidence).

Idempotent: guarded by a versioned anonymous_user_id, so it seeds once. Bump
SEED_VERSION (and optionally delete the old rows) to re-seed with new data.
"""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Tune, TuneRating
from .scoring import recompute

SEED_VERSION = "hipseed:v2"  # v2 = like/dislike votes (v1 was 1–5 stars)
_HIP_SEEDS_PATH = Path(__file__).resolve().parent.parent / "data" / "hip_seeds.py"

# target star (1–5) per list, hippest → least hip
TIER_STAR = {
    "best_hip_calls": 5.0,
    "ultra_hip": 4.8,
    "hippest_jam_tunes": 4.5,
    "hip_jam_session_tunes": 4.0,
    "not_hip_overplayed_jam_tunes": 2.3,
    "least_hip_jam_tunes": 1.6,
    "ultra_least_hip": 1.0,
}


def _norm(s: str) -> str:
    """Article-aware title key: 'The Sidewinder' == 'Sidewinder, The'."""
    s = s.lower()
    s = re.sub(r"^(the|a|an)\s+", "", s)
    s = re.sub(r",\s*(the|a|an)$", "", s)
    return re.sub(r"[^a-z0-9]", "", s)


def _load_lists() -> dict[str, list[str]]:
    spec = importlib.util.spec_from_file_location("hip_seeds", _HIP_SEEDS_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return {tier: getattr(mod, tier, []) for tier in TIER_STAR}


def _targets() -> dict[str, tuple[float, int]]:
    """norm(title) -> (target_star, number_of_list_memberships)."""
    acc: dict[str, list[float]] = {}
    for tier, lst in _load_lists().items():
        for title in lst:
            acc.setdefault(_norm(title), []).append(TIER_STAR[tier])
    return {k: (sum(v) / len(v), len(v)) for k, v in acc.items()}


def _likes_for(target_star: float, k: int) -> list[bool]:
    """k like/dislike votes whose like-rate ≈ the target star (1★→0%, 5★→100%)."""
    prob = (target_star - 1) / 4
    n_likes = max(0, min(k, round(prob * k)))
    return [True] * n_likes + [False] * (k - n_likes)


def seed_hipness(session: Session) -> None:
    """Insert seed star votes once (idempotent via SEED_VERSION)."""
    already = session.execute(
        select(TuneRating.id)
        .where(TuneRating.anonymous_user_id == SEED_VERSION)
        .limit(1)
    ).first()
    if already:
        return

    # resolve list titles to tunes (article-aware + alternate titles)
    by: dict[str, Tune] = {}
    for t in session.execute(select(Tune)).scalars():
        by.setdefault(_norm(t.title), t)
        for alt in (t.alternate_titles or []):
            by.setdefault(_norm(alt), t)

    seeded = 0
    for key, (target, n) in _targets().items():
        tune = by.get(key)
        if tune is None:
            continue
        k = min(12, 4 + 2 * n)
        for liked in _likes_for(target, k):
            session.add(TuneRating(
                tune_id=tune.id,
                anonymous_user_id=SEED_VERSION,
                liked=liked,
            ))
        recompute(session, tune)
        seeded += 1

    session.commit()
    if seeded:
        print(f"[db] seeded hipness votes for {seeded} tunes")
