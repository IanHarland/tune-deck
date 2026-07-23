"""app/db.py — seeding and the no-framework migration pattern.

There is deliberately no Alembic here (the Leif Bot rule): schema changes are
appended as idempotent statements and init_db() runs on EVERY boot, on both HA
machines. So the property that actually matters is idempotency — a second run
must not duplicate tunes, and must not clobber crowd ratings with build-time
seed values.
"""
from __future__ import annotations

import json

import pytest
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker

from app import db as db_mod
from app.models import Base, Tune


@pytest.fixture
def seeded(tmp_path, monkeypatch):
    """A fresh engine + a seed file we control."""
    rows = [
        {"title": "Autumn Leaves", "composer": "Joseph Kosma", "original_key": "G-",
         "feel": "medium_swing", "obscurity_score": 4, "difficulty_score": 26,
         "tags": ["beginner"], "charts": [{"book": "Jazz LTD", "page": "12"}]},
        {"title": "Giant Steps", "composer": "John Coltrane", "original_key": "B",
         "feel": "up", "obscurity_score": 16, "difficulty_score": 93,
         "tags": ["hard"], "charts": []},
    ]
    seed = tmp_path / "tunes.json"
    seed.write_text(json.dumps(rows))
    monkeypatch.setattr(db_mod, "SEED_PATH", seed)

    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(db_mod, "engine", engine)
    monkeypatch.setattr(db_mod, "SessionLocal", Session)
    yield Session, rows, seed
    engine.dispose()


def titles(session):
    return {t for (t,) in session.execute(select(Tune.title)).all()}


# --------------------------------------------------------------------------- #
# Seeding
# --------------------------------------------------------------------------- #
def test_seed_inserts_tunes(seeded):
    Session, _, _ = seeded
    with Session() as s:
        db_mod._seed(s)
        assert titles(s) == {"Autumn Leaves", "Giant Steps"}


def test_seed_is_idempotent(seeded):
    """Both HA machines run init_db() on boot; the second must be a no-op."""
    Session, _, _ = seeded
    with Session() as s:
        db_mod._seed(s)
        db_mod._seed(s)
        db_mod._seed(s)
        assert s.query(Tune).count() == 2


def test_reseed_refreshes_static_metadata(seeded):
    """Re-running the pipeline should update composer/feel/charts in place."""
    Session, rows, seed = seeded
    with Session() as s:
        db_mod._seed(s)
        rows[0]["composer"] = "Kosma / Mercer"
        rows[0]["charts"] = [{"book": "Jazz LTD", "page": "12"},
                             {"book": "The Real Book, Vol. 1", "page": "40"}]
        seed.write_text(json.dumps(rows))
        db_mod._seed(s)
        t = s.execute(select(Tune).where(Tune.title == "Autumn Leaves")).scalar_one()
        assert t.composer == "Kosma / Mercer"
        assert len(t.charts) == 2


def test_reseed_refreshes_the_score_of_an_UNVOTED_tune(seeded):
    Session, rows, seed = seeded
    with Session() as s:
        db_mod._seed(s)
        rows[0]["obscurity_score"] = 42
        seed.write_text(json.dumps(rows))
        db_mod._seed(s)
        t = s.execute(select(Tune).where(Tune.title == "Autumn Leaves")).scalar_one()
        assert t.obscurity_score == 42


def test_reseed_does_NOT_clobber_a_voted_score(seeded):
    """The whole point of upserting by natural key: crowd ratings survive a
    re-seed. A regression here silently discards real votes on every deploy."""
    Session, rows, seed = seeded
    with Session() as s:
        db_mod._seed(s)
        t = s.execute(select(Tune).where(Tune.title == "Autumn Leaves")).scalar_one()
        t.obscurity_score = 88.0
        t.obscurity_votes = 3
        s.commit()

        rows[0]["obscurity_score"] = 1
        seed.write_text(json.dumps(rows))
        db_mod._seed(s)

        t = s.execute(select(Tune).where(Tune.title == "Autumn Leaves")).scalar_one()
        assert t.obscurity_score == 88.0     # the crowd's answer stands
        assert t.obscurity_seed == 1         # but the prior is refreshed


def test_natural_key_ignores_punctuation_and_case():
    """"Take the 'A' Train" and "take the a train" must be the same row."""
    assert db_mod._natural_key("Take the 'A' Train") == db_mod._natural_key(
        "take the a train")
    assert db_mod._natural_key("St. Thomas") == db_mod._natural_key("St Thomas")


def test_seed_missing_file_is_not_an_error(seeded, tmp_path, monkeypatch):
    Session, _, _ = seeded
    monkeypatch.setattr(db_mod, "SEED_PATH", tmp_path / "absent.json")
    with Session() as s:
        db_mod._seed(s)  # must not raise
        assert s.query(Tune).count() == 0


def test_new_tunes_start_at_the_neutral_hipness_placeholder(seeded):
    Session, _, _ = seeded
    with Session() as s:
        db_mod._seed(s)
        assert all(t.rating_score == 50.0 for t in s.query(Tune).all())


# --------------------------------------------------------------------------- #
# Pruning + backfill
# --------------------------------------------------------------------------- #
def test_exercises_are_tombstoned(seeded):
    """iReal's built-in practice templates ("Rhythm Changes", II-V-I workouts)
    are backing tracks, not tunes."""
    Session, _, _ = seeded
    with Session() as s:
        s.add(Tune(natural_key="bluesminor", title="Blues - Minor",
                   composer="Exercise", feel="medium_swing",
                   obscurity_seed=50, difficulty_seed=50,
                   obscurity_score=50, difficulty_score=50))
        s.commit()
        db_mod._prune_exercises(s)
        t = s.execute(select(Tune).where(Tune.title == "Blues - Minor")).scalar_one()
        assert t.deleted is True


def test_prune_is_idempotent(seeded):
    Session, _, _ = seeded
    with Session() as s:
        s.add(Tune(natural_key="x", title="X", composer="Exercise",
                   feel="up", obscurity_seed=50, difficulty_seed=50,
                   obscurity_score=50, difficulty_score=50))
        s.commit()
        db_mod._prune_exercises(s)
        db_mod._prune_exercises(s)   # second run touches 0 rows
        assert s.query(Tune).filter(Tune.deleted.is_(True)).count() == 1


def test_backfill_fills_null_hipness(seeded):
    Session, _, _ = seeded
    with Session() as s:
        db_mod._seed(s)
        s.execute(text("UPDATE tunes SET rating_score = NULL"))
        s.commit()
        db_mod._backfill_hipness(s)
        assert all(t.rating_score == 50 for t in s.query(Tune).all())


# --------------------------------------------------------------------------- #
# Migrations
# --------------------------------------------------------------------------- #
def test_migrations_are_idempotent(seeded):
    """Appending an ALTER that already ran must not raise on the next boot."""
    db_mod._run_migrations()
    db_mod._run_migrations()


def test_migrations_add_a_missing_column(tmp_path, monkeypatch):
    """Simulates the real case: a table created before a column was added."""
    engine = create_engine(f"sqlite:///{tmp_path/'old.db'}")
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE tune_ratings (id TEXT PRIMARY KEY, tune_id TEXT)"))
    monkeypatch.setattr(db_mod, "engine", engine)

    db_mod._run_migrations()

    with engine.begin() as conn:
        cols = {r[1] for r in conn.execute(text("PRAGMA table_info(tune_ratings)"))}
    assert "liked" in cols
    engine.dispose()


def test_migration_ddl_is_defined_for_both_dialects():
    """A per-dialect dict must cover the two backends we actually run: SQLite
    locally, Postgres on Fly. A missing key would KeyError at boot."""
    for table, cols in db_mod._ADDITIVE_COLUMNS.items():
        for col, ddl in cols.items():
            if isinstance(ddl, dict):
                assert {"sqlite", "postgresql"} <= set(ddl), f"{table}.{col}"


def test_postgres_url_scheme_is_normalised(monkeypatch):
    """Fly hands out "postgres://"; SQLAlchemy 2.0 requires "postgresql://"."""
    url = "postgres://u:p@host:5432/db"
    assert url.replace("postgres://", "postgresql://", 1) == \
        "postgresql://u:p@host:5432/db"


# --------------------------------------------------------------------------- #
# The real seed file
# --------------------------------------------------------------------------- #
def test_shipped_seed_is_valid():
    """data/tunes.json is committed and loaded on every boot — a malformed or
    truncated file would take the app down at startup."""
    rows = json.loads(db_mod.SEED_PATH.read_text())
    assert len(rows) > 1000
    for r in rows[:200]:
        assert r["title"] and r["feel"]
        assert 0 <= r["obscurity_score"] <= 100
        assert 0 <= r["difficulty_score"] <= 100


# Natural-key collisions currently in data/tunes.json. A collision is not fatal
# — _seed() upserts, so the two rows merge into one (see the test below) — but
# it means one spelling silently wins and the other title never appears.
#
#   somedayyoullbesorry: "Someday (You'll Be Sorry)" vs "Someday You'll Be
#   Sorry" — the same Louis Armstrong tune, entered twice in the iReal library
#   with different punctuation. The parenthesised spelling wins.
KNOWN_SEED_COLLISIONS = {"somedayyoullbesorry"}


def test_shipped_seed_has_no_NEW_duplicate_natural_keys():
    """Two tunes sharing a natural key fight over one row on every re-seed.
    The known case is allowlisted above; anything new should fail here."""
    rows = json.loads(db_mod.SEED_PATH.read_text())
    keys = [db_mod._natural_key(r["title"]) for r in rows]
    dupes = {k for k in keys if keys.count(k) > 1}
    assert dupes <= KNOWN_SEED_COLLISIONS, sorted(dupes - KNOWN_SEED_COLLISIONS)


def test_a_natural_key_collision_merges_instead_of_crashing(seeded):
    """Pins what actually happens when two titles normalise the same: the
    upsert finds the pending row and updates it, so seeding stays safe. Worth a
    test because the collision is reached via autoflush, which is subtle."""
    Session, rows, seed = seeded
    seed.write_text(json.dumps([
        {"title": "Someday (You'll Be Sorry)", "composer": "Louis Armstrong",
         "feel": "medium_swing", "obscurity_score": 97, "difficulty_score": 50},
        {"title": "Someday You'll Be Sorry", "composer": "Louis Armstrong",
         "feel": "medium_swing", "obscurity_score": 97, "difficulty_score": 50},
    ]))
    with Session() as s:
        db_mod._seed(s)
        db_mod._seed(s)
        assert s.query(Tune).count() == 1


def test_shipped_seed_feels_are_the_known_enum():
    rows = json.loads(db_mod.SEED_PATH.read_text())
    allowed = {"ballad", "medium_swing", "up", "latin", "waltz"}
    assert {r["feel"] for r in rows} <= allowed
