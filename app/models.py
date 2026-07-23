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
    UniqueConstraint,
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
    time_signature = Column(Text, nullable=True)

    # fake-book chart references: [{"book": "The Real Book, Vol. 1", "page": "36"}]
    charts = Column(JSON, nullable=False, default=list)
    # mode tags, e.g. ["beginner"], ["hard"]
    tags = Column(JSON, nullable=False, default=list)

    # seed priors (never change after seeding) ...
    obscurity_seed = Column(Float, nullable=False, default=50)
    difficulty_seed = Column(Float, nullable=False, default=50)
    # ... and the current crowd-blended aggregates (what we filter/display on)
    obscurity_score = Column(Float, nullable=False, default=50)
    difficulty_score = Column(Float, nullable=False, default=50)
    obscurity_votes = Column(Integer, nullable=False, default=0)
    difficulty_votes = Column(Integer, nullable=False, default=0)

    # "hipness" = crowd like-rate, 0–100 (% of swipes that were a like). No seed
    # prior (nothing in iReal predicts taste); null until the first swipe.
    rating_score = Column(Float, nullable=True)
    rating_votes = Column(Integer, nullable=False, default=0)  # total likes+dislikes

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
            "time_signature": self.time_signature,
            "charts": self.charts or [],
            "tags": self.tags or [],
            "obscurity_score": round(self.obscurity_score, 1),
            "difficulty_score": round(self.difficulty_score, 1),
            "obscurity_votes": self.obscurity_votes,
            "difficulty_votes": self.difficulty_votes,
            "rating_score": round(self.rating_score, 1) if self.rating_score is not None else None,
            "rating_votes": self.rating_votes,
            "times_picked": self.times_picked,
            "times_played": self.times_played,
            "last_picked_at": self.last_picked_at.isoformat() if self.last_picked_at else None,
            "last_played_at": self.last_played_at.isoformat() if self.last_played_at else None,
        }


class TuneTranscription(Base):
    """A chart imported as MusicXML, scanned from a fake-book page.

    Stored because producing one is manual work (scan the page in Soundslice,
    correct what the scanner misread, export) and immutable afterwards — the
    printed page never changes. Transposition is applied at render time from
    this single stored copy, so all 12 keys come from one import.

    Keyed by (tune, book, page) rather than by tune alone: the same tune is
    often in several books with different arrangements, and the owner may
    prefer one book's chart.
    """
    __tablename__ = "tune_transcriptions"
    __table_args__ = (
        UniqueConstraint("tune_id", "book", "printed_page", name="uq_transcription_chart"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    tune_id = Column(String, ForeignKey("tunes.id", ondelete="CASCADE"),
                     nullable=False, index=True)

    # which chart this came from — mirrors an entry in Tune.charts
    book = Column(Text, nullable=False)
    printed_page = Column(Text, nullable=False)

    musicxml = Column(Text, nullable=False)
    # concert key the chart is printed in, derived from the transcribed key
    # signature. Transposition intervals are computed relative to this.
    source_key = Column(Text, nullable=True)

    # An import is corrected by hand in Soundslice before it's exported, so it
    # arrives verified. Kept as a column because the flag is what the UI trusts:
    # anything that ever lands here unchecked must say so. See CLAUDE.md.
    verified = Column(Boolean, nullable=False, default=False)

    # What produced the file — "soundslice", "opuscan", … Named `model` from the
    # days when a vision model wrote it; kept rather than renamed because the
    # column is free-text either way and a rename buys nothing.
    model = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=_now)
    updated_at = Column(DateTime(timezone=True), default=_now, onupdate=_now)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "tune_id": self.tune_id,
            "book": self.book,
            "printed_page": self.printed_page,
            "source_key": self.source_key,
            "verified": self.verified,
            "model": self.model,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class TuneRating(Base):
    __tablename__ = "tune_ratings"

    id = Column(String, primary_key=True, default=_uuid)
    tune_id = Column(String, ForeignKey("tunes.id", ondelete="CASCADE"),
                     nullable=False, index=True)
    anonymous_user_id = Column(String, nullable=True, index=True)

    obscurity_rating = Column(Float, nullable=True)
    difficulty_rating = Column(Float, nullable=True)
    liked = Column(Boolean, nullable=True)  # swipe: True=like, False=dislike

    created_at = Column(DateTime(timezone=True), default=_now)

    tune = relationship("Tune", back_populates="ratings")
