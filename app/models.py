"""SQLAlchemy models for Tune Deck.

Two tables: `tunes` (canonical tune data + current aggregate scores) and
`tune_ratings` (raw crowd weigh-ins). Aggregate obscurity/difficulty are stored
directly on the tune (alongside the keys) and recomputed from ratings via a
Bayesian blend with the seed prior — see scoring.py and CLAUDE.md.

Arrays are stored as JSON so the same models run on SQLite (local dev) and
Postgres (Fly). UUIDs are strings for the same reason.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text,
)
from sqlalchemy.orm import DeclarativeBase, relationship
from sqlalchemy.types import JSON

FEELS = ["ballad", "medium_swing", "up", "latin", "waltz"]


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Tune(Base):
    __tablename__ = "tunes"

    id = Column(String, primary_key=True, default=_uuid)
    # stable natural key (normalized title) for idempotent re-seeding
    natural_key = Column(String, unique=True, nullable=False, index=True)

    # soft-delete tombstone: hidden everywhere and NOT resurrected by re-seeding
    # (the seeder skips natural_keys that already exist). Lets users prune
    # exercises/junk imported from iReal permanently.
    deleted = Column(Boolean, nullable=False, default=False)

    title = Column(Text, nullable=False)
    alternate_titles = Column(JSON, nullable=False, default=list)
    composer = Column(Text, nullable=True)

    original_key = Column(Text, nullable=True)
    last_played_key = Column(Text, nullable=True)

    feel = Column(String, nullable=False)
    additional_feels = Column(JSON, nullable=False, default=list)

    ireal_style = Column(Text, nullable=True)
    ireal_url = Column(Text, nullable=True)

    # fake-book chart references: [{"book": "The Real Book, Vol. 1", "page": "36"}]
    charts = Column(JSON, nullable=False, default=list)

    # seed priors (never change after seeding) ...
    obscurity_seed = Column(Float, nullable=False, default=50)
    difficulty_seed = Column(Float, nullable=False, default=50)
    # ... and the current crowd-blended aggregates (what we filter/display on)
    obscurity_score = Column(Float, nullable=False, default=50)
    difficulty_score = Column(Float, nullable=False, default=50)
    obscurity_votes = Column(Integer, nullable=False, default=0)
    difficulty_votes = Column(Integer, nullable=False, default=0)

    # play history. NOTE: last_played_key (above) is the randomized KEY; the
    # *_at columns here are timestamps. "picked" = drawn from the deck;
    # "played" = the user confirmed the band actually played it.
    times_picked = Column(Integer, nullable=False, default=0)
    times_played = Column(Integer, nullable=False, default=0)
    last_picked_at = Column(DateTime(timezone=True), nullable=True)
    last_played_at = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(DateTime(timezone=True), default=_now)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now)

    ratings = relationship(
        "TuneRating", back_populates="tune", cascade="all, delete-orphan"
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "alternate_titles": self.alternate_titles or [],
            "composer": self.composer,
            "original_key": self.original_key,
            "last_played_key": self.last_played_key,
            "feel": self.feel,
            "additional_feels": self.additional_feels or [],
            "ireal_style": self.ireal_style,
            "ireal_url": self.ireal_url,
            "charts": self.charts or [],
            "obscurity_score": round(self.obscurity_score, 1),
            "difficulty_score": round(self.difficulty_score, 1),
            "obscurity_votes": self.obscurity_votes,
            "difficulty_votes": self.difficulty_votes,
            "times_picked": self.times_picked,
            "times_played": self.times_played,
            "last_picked_at": self.last_picked_at.isoformat() if self.last_picked_at else None,
            "last_played_at": self.last_played_at.isoformat() if self.last_played_at else None,
        }


class TuneRating(Base):
    __tablename__ = "tune_ratings"

    id = Column(String, primary_key=True, default=_uuid)
    tune_id = Column(String, ForeignKey("tunes.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    anonymous_user_id = Column(String, nullable=True, index=True)

    obscurity_rating = Column(Float, nullable=True)
    difficulty_rating = Column(Float, nullable=True)

    created_at = Column(DateTime(timezone=True), default=_now)

    tune = relationship("Tune", back_populates="ratings")
