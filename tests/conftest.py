"""Shared fixtures.

The environment is rewritten at IMPORT time, before anything under app/ is
imported, because app.db reads DATABASE_URL and app.fakebooks reads
FAKEBOOKS_DIR at module scope. Getting this wrong would point a test run at the
real Postgres or at the owner's 935 MB of book scans.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# --- must happen before `import app.*` ------------------------------------ #
_SANDBOX = Path(__file__).resolve().parent / "_sandbox"
os.environ["DATABASE_URL"] = "sqlite://"          # in-memory, per-process
os.environ["FAKEBOOKS_DIR"] = str(_SANDBOX / "books")   # empty: no PDFs to open
os.environ["CHARTS_DIR"] = str(_SANDBOX / "charts")     # empty: nothing to import
os.environ.pop("FAKEBOOK_PASSWORD", None)
os.environ.pop("FAKEBOOK_OFFSETS", None)

from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app.models import Base, Tune, TuneRating  # noqa: E402,F401


@pytest.fixture
def session():
    """A clean in-memory database per test."""
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    with Session() as s:
        yield s
    engine.dispose()


@pytest.fixture
def make_tune(session):
    """Factory for a Tune with sane defaults, committed to the test session."""
    import re

    def _make(title="Autumn Leaves", **kw):
        defaults = dict(
            natural_key=re.sub(r"[^a-z0-9]", "", title.lower()),
            title=title,
            composer="Joseph Kosma",
            original_key="G-",
            feel="medium_swing",
            additional_feels=[],
            charts=[],
            tags=[],
            obscurity_seed=4.0,
            difficulty_seed=26.0,
            obscurity_score=4.0,
            difficulty_score=26.0,
            rating_score=50.0,
        )
        defaults.update(kw)
        t = Tune(**defaults)
        session.add(t)
        session.commit()
        return t

    return _make


@pytest.fixture
def tune(make_tune):
    return make_tune()


@pytest.fixture
def client(monkeypatch):
    """Flask test client wired to a throwaway database.

    A bare "sqlite://" gives every CONNECTION its own empty database, so the
    routes would never see fixture data; StaticPool pins one shared connection
    for the life of the test.

    app.web builds its app at import time, so this configures rather than
    constructs. `fb` (the fake-book session flag) is left unset — tests that
    need the private reader set it explicitly, which is also how the gate itself
    gets tested.
    """
    from sqlalchemy.pool import StaticPool

    from app import web

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    monkeypatch.setattr(web, "SessionLocal", Session)
    web.app.config.update(TESTING=True, SECRET_KEY="test-secret")

    with web.app.test_client() as c:
        c.Session = Session  # so tests can seed/inspect the same database
        yield c
    engine.dispose()


@pytest.fixture
def authed_client(client):
    """Test client holding the fake-book session cookie."""
    with client.session_transaction() as s:
        s["fb"] = True
    return client


@pytest.fixture
def api_tune(client):
    """Factory putting a Tune in the database the routes read."""
    import re

    def _make(title="Autumn Leaves", **kw):
        defaults = dict(
            natural_key=re.sub(r"[^a-z0-9]", "", title.lower()),
            title=title, composer="Joseph Kosma", original_key="G-",
            feel="medium_swing", additional_feels=[], charts=[], tags=[],
            obscurity_seed=4.0, difficulty_seed=26.0,
            obscurity_score=4.0, difficulty_score=26.0, rating_score=50.0,
        )
        defaults.update(kw)
        with client.Session() as s:
            t = Tune(**defaults)
            s.add(t)
            s.commit()
            return t

    return _make
