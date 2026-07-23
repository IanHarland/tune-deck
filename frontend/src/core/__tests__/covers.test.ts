// core/covers.ts + core/irealLink.ts — two small portable helpers.
//
// coverSlug MUST agree with scripts/build_covers.py and app/fakebooks.py; a
// cross-language check lives in tests/test_parity.py. These tests pin the
// behaviour on the TypeScript side.
import { describe, expect, it } from "vitest";
import { coverSlug } from "../covers";
import { canOpenInIreal, irealUrlFor } from "../irealLink";
import type { Tune } from "../types";

describe("coverSlug", () => {
  it.each([
    ["The Real Book, Vol. 1", "the-real-book-vol-1"],
    ["The New Real Book, Vol. 3", "the-new-real-book-vol-3"],
    ["Jazz LTD", "jazz-ltd"],
    ["Library of Musicians' Jazz", "library-of-musicians-jazz"],
    ["Bill Evans Fake Book", "bill-evans-fake-book"],
  ])("%s -> %s", (name, expected) => {
    expect(coverSlug(name)).toBe(expected);
  });

  it("collapses runs of punctuation into one dash", () => {
    expect(coverSlug("A -- B")).toBe("a-b");
  });

  it("trims leading and trailing dashes", () => {
    expect(coverSlug("...Round Midnight...")).toBe("round-midnight");
  });

  it("is idempotent", () => {
    const once = coverSlug("The Real Book, Vol. 1");
    expect(coverSlug(once)).toBe(once);
  });
});

const tune = (over: Partial<Tune> = {}) => ({ ireal_url: null, ...over }) as Tune;

describe("irealLink", () => {
  it("returns the stored deep link", () => {
    const url = "irealb://Autumn%20Leaves%3DKosma";
    expect(irealUrlFor(tune({ ireal_url: url }))).toBe(url);
    expect(canOpenInIreal(tune({ ireal_url: url }))).toBe(true);
  });

  it("reports no link when the tune has none", () => {
    expect(irealUrlFor(tune())).toBeNull();
    expect(canOpenInIreal(tune())).toBe(false);
  });

  it("treats an empty string as no link", () => {
    expect(canOpenInIreal(tune({ ireal_url: "" }))).toBe(false);
  });
});
