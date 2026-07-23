"""Regression: fake-book PDFs must be read LAZILY.

pypdf's PdfReader slurps the whole file into a BytesIO when handed a path
(`_initialize_stream` does `BytesIO(fh.read())`). extract_pages used to do
exactly that, so pulling one 0.37 MB chart out of the 180 MB B♭ Real Book Vol. 1
cost 208 MB of RSS, OOM-killed the 512 MB machine, and reached the browser as a
502 after ~44 s of thrashing.

The fix is to hand pypdf an open file object instead. These tests pin both the
mechanism (never a path) and the outcome (memory stays flat as the book grows),
because the bug is invisible on a small file — every test PDF here would pass
under the broken code too.
"""
from __future__ import annotations

import io

import pytest

from app import fakebooks

pypdf = pytest.importorskip("pypdf")


def _make_pdf(path, pages: int, padding: int = 0):
    """A PDF with `pages` pages, each padded to inflate the file. Padding stands
    in for the scanned images that make the real books 30-180 MB."""
    writer = pypdf.PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=612, height=792)
    if padding:
        writer.add_metadata({"/Pad": "x" * padding})
    with open(path, "wb") as fh:
        writer.write(fh)
    return path


@pytest.fixture
def book(tmp_path, monkeypatch):
    """A stand-in book wired into fakebooks' lookup paths."""
    def _make(pages=20, padding=0, name="TEST.PDF"):
        _make_pdf(tmp_path / name, pages, padding)
        monkeypatch.setattr(fakebooks, "BOOKS_DIR", tmp_path)
        fakebooks._PAGE_COUNTS.clear()
        return {"file": name, "offset": 0}
    yield _make
    fakebooks._PAGE_COUNTS.clear()


# --------------------------------------------------------------------------- #
# The mechanism
# --------------------------------------------------------------------------- #
def test_pdfreader_is_never_handed_a_path(book, monkeypatch):
    """The actual regression. Given a str/Path, pypdf reads the ENTIRE file into
    memory; given a file object it seeks on demand. Passing a path here is the
    bug, regardless of what the output looks like."""
    cfg = book(pages=10)
    seen = []
    real = pypdf.PdfReader

    def spy(stream, *a, **kw):
        seen.append(stream)
        return real(stream, *a, **kw)

    monkeypatch.setattr(fakebooks, "PdfReader", spy)
    fakebooks.extract_pages(cfg, 1, 1)
    fakebooks.page_count(cfg)

    assert seen, "PdfReader was never called"
    for stream in seen:
        assert not isinstance(stream, (str, bytes)), \
            "PdfReader was handed a path — it will slurp the whole book into RAM"
        assert hasattr(stream, "read") and hasattr(stream, "seek")


def test_open_book_closes_the_handle(book):
    """The context manager owns the handle; leaking one per request would run
    the worker out of file descriptors."""
    cfg = book(pages=5)
    with fakebooks._open_book(cfg) as reader:
        assert len(reader.pages) == 5
        fh = reader.stream
    assert fh.closed


# --------------------------------------------------------------------------- #
# The outcome
# --------------------------------------------------------------------------- #
def test_memory_does_not_scale_with_book_size(book):
    """Peak allocation must stay roughly flat as the file grows. Under the old
    path-based code this scaled 1:1 with file size, which is what killed the
    512 MB machine."""
    import tracemalloc

    def peak_for(padding):
        cfg = book(padding=padding, name=f"P{padding}.PDF")
        tracemalloc.start()
        fakebooks.extract_pages(cfg, 1, 1)
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        return peak

    small = peak_for(0)
    large = peak_for(4_000_000)  # ~4 MB of padding
    # Lazy reading: the extra 4 MB must NOT all land in memory. Generous bound —
    # the broken version would show the full delta.
    assert large - small < 2_000_000, (
        f"peak grew {large - small} bytes for 4 MB of extra file — "
        "the whole book is being read into memory")


# --------------------------------------------------------------------------- #
# Correctness of what comes out
# --------------------------------------------------------------------------- #
def test_extract_returns_the_requested_span(book):
    cfg = book(pages=20)
    out = pypdf.PdfReader(io.BytesIO(fakebooks.extract_pages(cfg, 5, 3)))
    assert len(out.pages) == 3


def test_extract_single_page(book):
    cfg = book(pages=20)
    assert len(pypdf.PdfReader(io.BytesIO(fakebooks.extract_pages(cfg, 1, 1))).pages) == 1


def test_extract_clamps_a_span_running_past_the_end(book):
    """The span is inferred from the index, so it can overrun the last tune."""
    cfg = book(pages=10)
    out = pypdf.PdfReader(io.BytesIO(fakebooks.extract_pages(cfg, 9, 4)))
    assert len(out.pages) == 2


def test_extract_count_of_zero_still_yields_a_page(book):
    cfg = book(pages=10)
    assert len(pypdf.PdfReader(io.BytesIO(fakebooks.extract_pages(cfg, 3, 0))).pages) == 1


def test_page_count(book):
    assert fakebooks.page_count(book(pages=17)) == 17


def test_page_count_is_cached(book, monkeypatch):
    """Reopening a 500 MB PDF isn't free."""
    cfg = book(pages=8)
    assert fakebooks.page_count(cfg) == 8
    calls = []
    monkeypatch.setattr(fakebooks, "PdfReader",
                        lambda *a, **k: calls.append(1) or pytest.fail("reopened"))
    assert fakebooks.page_count(cfg) == 8
    assert not calls


def test_page_count_of_a_missing_file_is_zero(monkeypatch, tmp_path):
    """A book that isn't staged must report 0, not raise — that's what keeps the
    reader dark instead of erroring."""
    monkeypatch.setattr(fakebooks, "BOOKS_DIR", tmp_path)
    fakebooks._PAGE_COUNTS.clear()
    assert fakebooks.page_count({"file": "ABSENT.PDF", "offset": 0}) == 0
