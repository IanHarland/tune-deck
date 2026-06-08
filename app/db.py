"""Database engine, session factory, and idempotent init/seed.

No migration framework (Leif Bot rule): schema is created from the models and
the seed is upserted by `natural_key`, so `init_db()` is safe to run on every
startup without clobbering crowd ratings.

Local dev defaults to SQLite (no setup). Fly provides DATABASE_URL -> Postgres.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.orm import Session, sessionmaker

from .hip_seed import seed_hipness
from .models import Base, Tune

_DEFAULT_SQLITE = f"sqlite:///{Path(__file__).resolve().parent.parent / 'tunedeck.db'}"
DATABASE_URL = os.environ.get("DATABASE_URL", _DEFAULT_SQLITE)

# Fly/Heroku-style "postgres://" -> SQLAlchemy's "postgresql://"
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = DATABASE_URL.replace("postgres://", "postgresql://", 1)

_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, pool_pre_ping=True, connect_args=_connect_args)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)

SEED_PATH = Path(__file__).resolve().parent.parent / "data" / "tunes.json"


# Additive columns added after the first deploy, keyed by table. create_all()
# won't ALTER an existing table, so (Leif Bot pattern) we add missing columns
# idempotently. A value may be a single DDL string (works on both backends) or
# a per-dialect dict where the DDL differs (e.g. boolean defaults).
_ADDITIVE_COLUMNS = {
    "tunes": {
        "times_played": "ALTER TABLE tunes ADD COLUMN times_played INTEGER NOT NULL DEFAULT 0",
        "last_picked_at": "ALTER TABLE tunes ADD COLUMN last_picked_at TIMESTAMP",
        "last_played_at": "ALTER TABLE tunes ADD COLUMN last_played_at TIMESTAMP",
        # JSON storage is TEXT on SQLite, native JSON on Postgres; TEXT works for both.
        "charts": "ALTER TABLE tunes ADD COLUMN charts TEXT",
        "tags": {
            "sqlite": "ALTER TABLE tunes ADD COLUMN tags TEXT",
            "postgresql": "ALTER TABLE tunes ADD COLUMN tags JSON",
        },
        "time_signature": "ALTER TABLE tunes ADD COLUMN time_signature TEXT",
        "deleted": {
            "sqlite": "ALTER TABLE tunes ADD COLUMN deleted BOOLEAN NOT NULL DEFAULT 0",
            "postgresql": "ALTER TABLE tunes ADD COLUMN deleted BOOLEAN NOT NULL DEFAULT false",
        },
        "rating_score": "ALTER TABLE tunes ADD COLUMN rating_score FLOAT",
        "rating_votes": "ALTER TABLE tunes ADD COLUMN rating_votes INTEGER NOT NULL DEFAULT 0",
    },
    "tune_ratings": {
        "liked": "ALTER TABLE tune_ratings ADD COLUMN liked BOOLEAN",
    },
}


def init_db() -> None:
    """Create tables, run additive migrations, load the seed. Run on startup."""
    Base.metadata.create_all(engine)
    _run_migrations()
    with SessionLocal() as session:
        _seed(session)
        seed_hipness(session)


def _run_migrations() -> None:
    inspector = inspect(engine)
    tables = set(inspector.get_table_names())
    dialect = engine.dialect.name
    with engine.begin() as conn:
        for table, cols in _ADDITIVE_COLUMNS.items():
            if table not in tables:
                continue
            existing = {c["name"] for c in inspector.get_columns(table)}
            for col, ddl in cols.items():
                if col in existing:
                    continue
                stmt = ddl[dialect] if isinstance(ddl, dict) else ddl
                conn.execute(text(stmt))
                print(f"[db] migrated: added {table}.{col}")


def _natural_key(title: str) -> str:
    import re
    return re.sub(r"[^a-z0-9]", "", title.lower())


def _seed(session: Session) -> None:
    if not SEED_PATH.exists():
        return
    rows = json.loads(SEED_PATH.read_text())
    existing = {k for (k,) in session.execute(select(Tune.natural_key)).all()}

    added = 0
    for r in rows:
        nk = _natural_key(r["title"])
        if nk in existing:
            # Refresh static metadata + the seed prior. The displayed aggregate
            # follows the new seed only while a tune is unvoted; once the crowd
            # has weighed in, leave it (it re-blends with the new seed on the
            # next vote via scoring.recompute).
            tune = session.execute(
                select(Tune).where(Tune.natural_key == nk)
            ).scalar_one()
            tune.composer = r.get("composer")
            tune.original_key = r.get("original_key")
            tune.feel = r["feel"]
            tune.additional_feels = r.get("additional_feels", [])
            tune.ireal_style = r.get("ireal_style")
            tune.ireal_url = r.get("ireal_url")
            tune.time_signature = r.get("time_signature")
            tune.charts = r.get("charts", [])
            tune.tags = r.get("tags", [])
            tune.obscurity_seed = r["obscurity_score"]
            tune.difficulty_seed = r["difficulty_score"]
            if tune.obscurity_votes == 0:
                tune.obscurity_score = r["obscurity_score"]
            if tune.difficulty_votes == 0:
                tune.difficulty_score = r["difficulty_score"]
            continue
        obs = r["obscurity_score"]
        dif = r["difficulty_score"]
        session.add(Tune(
            natural_key=nk,
            title=r["title"],
            alternate_titles=r.get("alternate_titles", []),
            composer=r.get("composer"),
            original_key=r.get("original_key"),
            feel=r["feel"],
            additional_feels=r.get("additional_feels", []),
            ireal_style=r.get("ireal_style"),
            ireal_url=r.get("ireal_url"),
            time_signature=r.get("time_signature"),
            charts=r.get("charts", []),
            tags=r.get("tags", []),
            obscurity_seed=obs, difficulty_seed=dif,
            obscurity_score=obs, difficulty_score=dif,
        ))
        existing.add(nk)
        added += 1
    session.commit()
    if added:
        print(f"[db] seeded {added} new tunes")
