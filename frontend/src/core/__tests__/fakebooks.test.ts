// core/fakebooks.ts — which chart rows are tappable, and which PRINTING they
// open. The rules here exist to prevent one specific failure: a horn player
// tapping a row badged B♭ and being handed a concert chart (or somebody else's
// tune entirely). Falling back to concert is fine; silently CLAIMING to be
// transposed is not.
import { describe, expect, it } from "vitest";
import {
  canOpenPage,
  editionFor,
  fakebookTuneUrl,
  pageToken,
  parsePageRef,
  type FakebookInfo,
} from "../fakebooks";

const book = (over: Partial<FakebookInfo> = {}): FakebookInfo => ({
  slug: "the-real-book-vol-1",
  offsets: { "": 13 },
  available: true,
  editions: {},
  ...over,
});

describe("parsePageRef", () => {
  it.each([
    ["288", { section: "", number: 288 }],
    [288, { section: "", number: 288 }],
    ["A1", { section: "A", number: 1 }],
    ["a13", { section: "A", number: 13 }],
    ["  42  ", { section: "", number: 42 }],
  ])("parses %s", (input, expected) => {
    expect(parsePageRef(input as string | number)).toEqual(expected);
  });

  it.each(["", "xyz", "12345", "A", "1A", "-1", "1.5"])("rejects %s", (input) => {
    expect(parsePageRef(input)).toBeNull();
  });
});

describe("pageToken", () => {
  it("canonicalises for the URL", () => {
    expect(pageToken("  a1 ")).toBe("A1");
    expect(pageToken(288)).toBe("288");
  });

  it("is null for a non-page", () => {
    expect(pageToken("junk")).toBeNull();
  });
});

describe("canOpenPage", () => {
  it("needs the PDF present", () => {
    expect(canOpenPage(book({ available: false }), "100")).toBe(false);
    expect(canOpenPage(book(), "100")).toBe(true);
  });

  it("needs a known offset for the page's section", () => {
    // A ref into a section we can't locate would look tappable and do nothing.
    expect(canOpenPage(book(), "A1")).toBe(false);
    expect(canOpenPage(book({ offsets: { "": 13, A: 497 } }), "A1")).toBe(true);
  });

  it("is false for an unknown book", () => {
    expect(canOpenPage(undefined, "100")).toBe(false);
  });

  it("is false for an unparseable page", () => {
    expect(canOpenPage(book(), "not-a-page")).toBe(false);
  });
});

describe("editionFor", () => {
  const withBb = book({ editions: { Bb: { offsets: { "": 9 } } } });

  it("is concert for a C player", () => {
    expect(editionFor(withBb, "100", "C")).toBe("");
  });

  it("returns the printing when it is stocked", () => {
    expect(editionFor(withBb, "100", "Bb")).toBe("Bb");
  });

  it("falls back to concert when the printing is not stocked", () => {
    // Vol. 3 has a Bb printing but no Eb one; F has no books at all.
    expect(editionFor(withBb, "100", "Eb")).toBe("");
    expect(editionFor(withBb, "100", "F")).toBe("");
  });

  it("falls back to concert for a section the edition does not cover", () => {
    // Real Book Vol. 1's A-appendix resolves only in the concert book — the
    // transposed printings carry no `sections`.
    const b = book({
      offsets: { "": 13, A: 497 },
      editions: { Bb: { offsets: { "": 9 } } },
    });
    expect(editionFor(b, "100", "Bb")).toBe("Bb");
    expect(editionFor(b, "A1", "Bb")).toBe("");
  });

  it("is concert for a book with no editions at all", () => {
    expect(editionFor(book(), "100", "Bb")).toBe("");
  });

  it("handles missing inputs", () => {
    expect(editionFor(undefined, "100", "Bb")).toBe("");
    expect(editionFor(withBb, "100", null)).toBe("");
    expect(editionFor(withBb, "100", undefined)).toBe("");
  });
});

describe("fakebookTuneUrl", () => {
  it("builds the concert URL", () => {
    expect(fakebookTuneUrl("the-real-book-vol-1", "436")).toContain(
      "/api/fakebook/the-real-book-vol-1/tune-p436.pdf",
    );
  });

  it("appends the edition when transposed", () => {
    const url = fakebookTuneUrl("the-real-book-vol-1", "436", "Bb");
    expect(url).toContain("tune-p436.pdf?edition=Bb");
  });

  it("omits the query for concert pitch", () => {
    expect(fakebookTuneUrl("x", "1", "")).not.toContain("?");
  });

  it("canonicalises the page token", () => {
    expect(fakebookTuneUrl("x", " a1 ")).toContain("tune-pA1.pdf");
  });

  it("URL-encodes the edition", () => {
    expect(fakebookTuneUrl("x", "1", "B b")).toContain("edition=B%20b");
  });
});

describe("the reported B♭ failure", () => {
  // Fee-Fi-Fo-Fum, Real Book Vol. 1 p436 in Bb — the ref that 502'd.
  const b = book({ editions: { Bb: { offsets: { "": 9 } }, Eb: { offsets: { "": 10 } } } });

  it("is openable, badged Bb, and points at the Bb PDF", () => {
    expect(canOpenPage(b, "436")).toBe(true);
    expect(editionFor(b, "436", "Bb")).toBe("Bb");
    expect(fakebookTuneUrl(b.slug, "436", editionFor(b, "436", "Bb"))).toBe(
      "/api/fakebook/the-real-book-vol-1/tune-p436.pdf?edition=Bb",
    );
  });
});
