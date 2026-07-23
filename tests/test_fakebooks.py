"""app/fakebooks.py — page refs, offsets, editions, and the password gate.

The stakes here are specific: this module decides WHICH PAGE of a 500-page scan
gets handed over. An off-by-one silently returns somebody else's tune, and
nothing downstream can tell. So the tests lean on the calibration facts recorded
in CLAUDE.md rather than just checking the code agrees with itself.
"""
from __future__ import annotations

import json
import os

import pytest

from app import fakebooks


# --------------------------------------------------------------------------- #
# parse_page — "288" and "A1" are both valid printed refs
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("token,expected", [
    ("288", ("", 288)),
    (288, ("", 288)),
    ("1", ("", 1)),
    ("A1", ("A", 1)),
    ("a13", ("A", 13)),      # lowercase section normalises up
    ("  42  ", ("", 42)),    # stray whitespace
])
def test_parse_page(token, expected):
    assert fakebooks.parse_page(token) == expected


@pytest.mark.parametrize("token", ["", "xyz", "12345", "A", "1A", "12-3", "-1", "1.5"])
def test_parse_page_rejects_non_pages(token):
    assert fakebooks.parse_page(token) is None


def test_any_letter_is_a_valid_section():
    """The grammar is <optional letter><number>, so "p12" is section P page 12,
    not a malformed "page 12". Only "A" is actually in use (Real Book Vol. 1's
    appendix), but parsing stays general — an unknown section is rejected later
    by pdf_page_for, which has the offsets to know."""
    assert fakebooks.parse_page("p12") == ("P", 12)
    assert fakebooks.parse_page("B7") == ("B", 7)


# --------------------------------------------------------------------------- #
# slug — must match build_covers.py and the frontend's coverSlug()
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("name,expected", [
    ("The Real Book, Vol. 1", "the-real-book-vol-1"),
    ("The New Real Book, Vol. 3", "the-new-real-book-vol-3"),
    ("Jazz LTD", "jazz-ltd"),
    ("Library of Musicians' Jazz", "library-of-musicians-jazz"),
    ("The Colorado Cookbook", "the-colorado-cookbook"),
    ("Bill Evans Fake Book", "bill-evans-fake-book"),
])
def test_slug(name, expected):
    assert fakebooks.slug(name) == expected


def test_every_book_slug_is_unique():
    """Slugs are the URL key — a collision would serve the wrong book."""
    slugs = [fakebooks.slug(n) for n in fakebooks.BOOKS]
    assert len(slugs) == len(set(slugs))


def test_book_for_slug_round_trips():
    for name in fakebooks.BOOKS:
        found = fakebooks.book_for_slug(fakebooks.slug(name))
        assert found is not None and found[0] == name


def test_book_for_slug_unknown():
    assert fakebooks.book_for_slug("no-such-book") is None


# --------------------------------------------------------------------------- #
# offsets_for
# --------------------------------------------------------------------------- #
def test_offsets_main_run():
    cfg = fakebooks.BOOKS["The Real Book, Vol. 2"]
    assert fakebooks.offsets_for("The Real Book, Vol. 2", cfg)[""] == 7


def test_offsets_include_sections():
    """Real Book Vol. 1's unnumbered appendix (A1–A13) sits at PDF 498–510."""
    name = "The Real Book, Vol. 1"
    offsets = fakebooks.offsets_for(name, fakebooks.BOOKS[name])
    assert offsets[""] == 13
    assert offsets["A"] == 497


def test_offsets_for_unstocked_edition_is_empty():
    """Vol. 3 has a B♭ printing but no E♭ one."""
    name = "The Real Book, Vol. 3"
    cfg = fakebooks.BOOKS[name]
    assert fakebooks.offsets_for(name, cfg, "Bb") == {"": 8}
    assert fakebooks.offsets_for(name, cfg, "Eb") == {}


def test_editions_carry_no_sections():
    """An edition inherits NOTHING from its parent. Whether the transposed
    printings even contain Vol. 1's appendix is unverified, and guessing an
    offset for it is how you hand a horn player a random page."""
    name = "The Real Book, Vol. 1"
    assert "A" not in fakebooks.offsets_for(name, fakebooks.BOOKS[name], "Bb")


# --------------------------------------------------------------------------- #
# FAKEBOOK_OFFSETS override — recalibrate without a 935 MB rebuild
# --------------------------------------------------------------------------- #
@pytest.fixture
def offsets_env(monkeypatch):
    def _set(mapping):
        monkeypatch.setenv("FAKEBOOK_OFFSETS", json.dumps(mapping))
    yield _set
    monkeypatch.delenv("FAKEBOOK_OFFSETS", raising=False)


def test_override_accepts_a_bare_number(offsets_env):
    offsets_env({"the-real-book-vol-2": 99})
    cfg = fakebooks.BOOKS["The Real Book, Vol. 2"]
    assert fakebooks.offsets_for("The Real Book, Vol. 2", cfg)[""] == 99


def test_override_accepts_a_section_map(offsets_env):
    offsets_env({"the-real-book-vol-1": {"": 14, "A": 500}})
    name = "The Real Book, Vol. 1"
    out = fakebooks.offsets_for(name, fakebooks.BOOKS[name])
    assert out[""] == 14 and out["A"] == 500


def test_override_of_an_edition_uses_its_own_key(offsets_env):
    """`<slug>@Bb` is deliberately separate from the concert book's key, so a
    section map for the concert book can't collide with an edition offset."""
    offsets_env({"the-real-book-vol-1": 1, "the-real-book-vol-1@Bb": 42})
    name, cfg = "The Real Book, Vol. 1", fakebooks.BOOKS["The Real Book, Vol. 1"]
    assert fakebooks.offsets_for(name, cfg)[""] == 1
    assert fakebooks.offsets_for(name, cfg, "Bb")[""] == 42


def test_malformed_override_falls_back_to_baked_in(monkeypatch):
    """A broken secret must not take the reader down."""
    monkeypatch.setenv("FAKEBOOK_OFFSETS", "{not json")
    cfg = fakebooks.BOOKS["The Real Book, Vol. 2"]
    assert fakebooks.offsets_for("The Real Book, Vol. 2", cfg)[""] == 7


# --------------------------------------------------------------------------- #
# edition_cfg
# --------------------------------------------------------------------------- #
def test_edition_cfg_concert_is_the_book_itself():
    cfg = fakebooks.BOOKS["The Real Book, Vol. 1"]
    assert fakebooks.edition_cfg(cfg, None) is cfg
    assert fakebooks.edition_cfg(cfg, "") is cfg
    assert fakebooks.edition_cfg(cfg, "C") is cfg
    assert fakebooks.edition_cfg(cfg, "c") is cfg


def test_edition_cfg_returns_the_transposed_file():
    cfg = fakebooks.BOOKS["The Real Book, Vol. 1"]
    assert fakebooks.edition_cfg(cfg, "Bb")["file"] == "REALBK1_BB.PDF"
    assert fakebooks.edition_cfg(cfg, "Eb")["file"] == "REALBK1_EB.PDF"


def test_edition_cfg_unstocked_is_none_not_a_fallback():
    """404 rather than fall back: a horn player must never get concert pitch
    while believing they asked for B♭."""
    assert fakebooks.edition_cfg(fakebooks.BOOKS["The Real Book, Vol. 3"], "Eb") is None
    assert fakebooks.edition_cfg(fakebooks.BOOKS["Jazz LTD"], "Bb") is None


def test_new_real_books_stock_no_editions():
    """Deliberately absent: separately paginated AND the scans are incomplete
    (~11-13% of pages missing), so a constant offset cannot work. See CLAUDE.md."""
    for name in ("The New Real Book, Vol. 1", "The New Real Book, Vol. 2",
                 "The New Real Book, Vol. 3"):
        assert not fakebooks.BOOKS[name].get("editions"), name


# --------------------------------------------------------------------------- #
# pdf_page_for — the arithmetic that picks the physical page
# --------------------------------------------------------------------------- #
@pytest.fixture
def fake_page_count(monkeypatch):
    """page_count() needs a real PDF; tests run with an empty books dir."""
    monkeypatch.setattr(fakebooks, "page_count", lambda cfg: 600)


def test_pdf_page_applies_the_offset(fake_page_count):
    name, cfg = "The Real Book, Vol. 1", fakebooks.BOOKS["The Real Book, Vol. 1"]
    assert fakebooks.pdf_page_for(name, cfg, "100") == 113  # 100 + 13


def test_pdf_page_applies_the_section_offset(fake_page_count):
    """A1 (Alfie) is PDF 498, not page 1 + 13."""
    name, cfg = "The Real Book, Vol. 1", fakebooks.BOOKS["The Real Book, Vol. 1"]
    assert fakebooks.pdf_page_for(name, cfg, "A1") == 498
    assert fakebooks.pdf_page_for(name, cfg, "A13") == 510


def test_pdf_page_uses_the_edition_offset(fake_page_count):
    """Calibrated 2026-07-22: RealBk1 B♭ +9, E♭ +10 (CLAUDE.md)."""
    name, cfg = "The Real Book, Vol. 1", fakebooks.BOOKS["The Real Book, Vol. 1"]
    assert fakebooks.pdf_page_for(name, cfg, "100", "Bb") == 109
    assert fakebooks.pdf_page_for(name, cfg, "100", "Eb") == 110


def test_the_reported_bb_failure_resolves(fake_page_count):
    """Fee-Fi-Fo-Fum, printed p436 in B♭ -> PDF 445. This is the ref that 502'd
    when pypdf was slurping the whole 180 MB scan into memory."""
    name, cfg = "The Real Book, Vol. 1", fakebooks.BOOKS["The Real Book, Vol. 1"]
    assert fakebooks.pdf_page_for(name, cfg, "436", "Bb") == 445


def test_pdf_page_unknown_section_is_none(fake_page_count):
    """404 rather than clamp — a bad index ref must fail visibly, not quietly
    hand over the wrong chart."""
    name, cfg = "The Real Book, Vol. 1", fakebooks.BOOKS["The Real Book, Vol. 1"]
    assert fakebooks.pdf_page_for(name, cfg, "Z5") is None


def test_pdf_page_section_only_resolves_in_concert(fake_page_count):
    name, cfg = "The Real Book, Vol. 1", fakebooks.BOOKS["The Real Book, Vol. 1"]
    assert fakebooks.pdf_page_for(name, cfg, "A1") is not None
    assert fakebooks.pdf_page_for(name, cfg, "A1", "Bb") is None


def test_pdf_page_past_end_of_scan_is_none(monkeypatch):
    monkeypatch.setattr(fakebooks, "page_count", lambda cfg: 100)
    name, cfg = "The Real Book, Vol. 1", fakebooks.BOOKS["The Real Book, Vol. 1"]
    assert fakebooks.pdf_page_for(name, cfg, "500") is None


def test_pdf_page_before_start_is_none(monkeypatch):
    """Jazz Fakebook's offset is -1, so printed page 1 would be PDF page 0."""
    monkeypatch.setattr(fakebooks, "page_count", lambda cfg: 448)
    name, cfg = "Jazz Fakebook", fakebooks.BOOKS["Jazz Fakebook"]
    assert fakebooks.pdf_page_for(name, cfg, "1") is None
    assert fakebooks.pdf_page_for(name, cfg, "2") == 1


def test_pdf_page_unparseable_token_is_none(fake_page_count):
    name, cfg = "The Real Book, Vol. 1", fakebooks.BOOKS["The Real Book, Vol. 1"]
    assert fakebooks.pdf_page_for(name, cfg, "not-a-page") is None


def test_pdf_page_unstocked_edition_is_none(fake_page_count):
    name, cfg = "The Real Book, Vol. 3", fakebooks.BOOKS["The Real Book, Vol. 3"]
    assert fakebooks.pdf_page_for(name, cfg, "150", "Eb") is None


# --------------------------------------------------------------------------- #
# span_for — how many pages a tune occupies
# --------------------------------------------------------------------------- #
def test_span_is_the_gap_to_the_next_indexed_tune(monkeypatch):
    monkeypatch.setattr(fakebooks, "_BOOK_PRINTED_PAGES",
                        {("Test Book", ""): [10, 12, 15, 40]})
    assert fakebooks.span_for("Test Book", "10") == 2   # 10 -> 12
    assert fakebooks.span_for("Test Book", "12") == 3   # 12 -> 15


def test_span_is_capped(monkeypatch):
    """A rare index hole or a run of photos mustn't export a whole section."""
    monkeypatch.setattr(fakebooks, "_BOOK_PRINTED_PAGES",
                        {("Test Book", ""): [10, 400]})
    assert fakebooks.span_for("Test Book", "10") == fakebooks.SPAN_CAP


def test_span_of_the_last_tune_is_one(monkeypatch):
    monkeypatch.setattr(fakebooks, "_BOOK_PRINTED_PAGES",
                        {("Test Book", ""): [10, 12]})
    assert fakebooks.span_for("Test Book", "12") == 1


def test_span_counts_sections_separately(monkeypatch):
    """A1's neighbour is A2, not page 2."""
    monkeypatch.setattr(fakebooks, "_BOOK_PRINTED_PAGES",
                        {("Test Book", ""): [1, 2], ("Test Book", "A"): [1, 3]})
    assert fakebooks.span_for("Test Book", "A1") == 2


def test_span_unknown_book_is_one(monkeypatch):
    monkeypatch.setattr(fakebooks, "_BOOK_PRINTED_PAGES", {})
    assert fakebooks.span_for("Nope", "10") == 1


def test_span_of_a_bad_token_is_one():
    assert fakebooks.span_for("The Real Book, Vol. 1", "junk") == 1


def test_real_span_data_loaded():
    """Guards against charts.json going missing — every span would silently
    become 1 and multi-page New Real Book arrangements would come across cut."""
    assert fakebooks._BOOK_PRINTED_PAGES, "charts.json failed to load"
    assert ("The Real Book, Vol. 1", "") in fakebooks._BOOK_PRINTED_PAGES


# --------------------------------------------------------------------------- #
# Password gate
# --------------------------------------------------------------------------- #
def test_password_unset_means_unconfigured(monkeypatch):
    monkeypatch.delenv("FAKEBOOK_PASSWORD", raising=False)
    assert fakebooks.password() is None
    assert fakebooks.check_password("anything") is False


def test_empty_password_is_unconfigured(monkeypatch):
    monkeypatch.setenv("FAKEBOOK_PASSWORD", "")
    assert fakebooks.password() is None


def test_check_password(monkeypatch):
    monkeypatch.setenv("FAKEBOOK_PASSWORD", "hunter2")
    assert fakebooks.check_password("hunter2") is True
    assert fakebooks.check_password("Hunter2") is False
    assert fakebooks.check_password("") is False


def test_meta_reports_unconfigured_without_a_password(monkeypatch):
    monkeypatch.delenv("FAKEBOOK_PASSWORD", raising=False)
    assert fakebooks.meta()["configured"] is False


def test_meta_lists_every_book(monkeypatch):
    monkeypatch.setenv("FAKEBOOK_PASSWORD", "x")
    m = fakebooks.meta()
    assert m["configured"] is True
    assert set(m["books"]) == set(fakebooks.BOOKS)


def test_meta_hides_books_whose_pdf_is_absent():
    """Tests run with an empty books dir, so nothing is available — which is
    exactly the state a fresh clone is in, and it must stay dark, not error."""
    m = fakebooks.meta()
    assert all(b["available"] is False for b in m["books"].values())


def test_meta_only_lists_editions_that_are_on_disk():
    """An edition whose file is missing must not be advertised, or the UI would
    badge a row B♭ and then 404 on tap."""
    m = fakebooks.meta()
    assert m["books"]["The Real Book, Vol. 1"]["editions"] == {}
