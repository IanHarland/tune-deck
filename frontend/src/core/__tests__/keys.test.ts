// core/keys.ts — key spelling, key-signature cards, instrument transposition.
//
// The card mapping is the app's own visual language: a key's number of
// accidentals is the RANK, sharps are red, flats are black, and the suit also
// encodes mode. Getting it wrong doesn't crash anything, it just prints the
// wrong card — so it needs pinning.
import { describe, expect, it } from "vitest";
import {
  INSTRUMENTS,
  MAJOR_KEYS,
  MINOR_KEYS,
  isMinor,
  keyCard,
  randomKeyInMode,
  toRelativeMajor,
  transposeKey,
} from "../keys";

describe("isMinor", () => {
  it.each(["A-", "Am", "Amin", "a-", "C#-", "Bbmin"])("%s is minor", (k) => {
    expect(isMinor(k)).toBe(true);
  });

  it.each(["A", "Bb", "C#", "F"])("%s is major", (k) => {
    expect(isMinor(k)).toBe(false);
  });

  it("treats missing keys as major", () => {
    expect(isMinor(null)).toBe(false);
    expect(isMinor(undefined)).toBe(false);
    expect(isMinor("")).toBe(false);
  });
});

describe("key tables", () => {
  it("has 12 of each", () => {
    expect(MAJOR_KEYS).toHaveLength(12);
    expect(MINOR_KEYS).toHaveLength(12);
  });

  it("spells major with flats and minor with sharps", () => {
    // No "Db minor" — it's C# minor.
    expect(MAJOR_KEYS).toContain("Db");
    expect(MAJOR_KEYS).toContain("Gb");
    expect(MINOR_KEYS).toContain("C#");
    expect(MINOR_KEYS).toContain("F#");
    expect(MINOR_KEYS).not.toContain("Db");
    expect(MINOR_KEYS).not.toContain("Gb");
  });
});

describe("randomKeyInMode", () => {
  it("keeps a minor tune minor", () => {
    for (let i = 0; i < 50; i++) {
      const k = randomKeyInMode("G-");
      expect(k.endsWith("-")).toBe(true);
      expect(MINOR_KEYS).toContain(k.slice(0, -1));
    }
  });

  it("keeps a major tune major", () => {
    for (let i = 0; i < 50; i++) {
      expect(MAJOR_KEYS).toContain(randomKeyInMode("Bb"));
    }
  });

  it("eventually produces more than one key", () => {
    const seen = new Set(Array.from({ length: 200 }, () => randomKeyInMode("C")));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("keyCard", () => {
  it("gives C major and A minor no suit", () => {
    expect(keyCard("C")).toEqual({ count: 0, suit: null, color: null });
    expect(keyCard("A-")).toEqual({ count: 0, suit: null, color: null });
  });

  it("counts sharps as red hearts for major keys", () => {
    // A major = 3 sharps = 3♥
    expect(keyCard("A")).toEqual({ count: 3, suit: "heart", color: "red" });
    expect(keyCard("G")).toEqual({ count: 1, suit: "heart", color: "red" });
  });

  it("counts flats as black spades for major keys", () => {
    // Bb major = 2 flats = 2♠
    expect(keyCard("Bb")).toEqual({ count: 2, suit: "spade", color: "black" });
    expect(keyCard("F")).toEqual({ count: 1, suit: "spade", color: "black" });
  });

  it("uses diamonds for sharp minor and clubs for flat minor", () => {
    expect(keyCard("E-")).toEqual({ count: 1, suit: "diamond", color: "red" });
    expect(keyCard("D-")).toEqual({ count: 1, suit: "club", color: "black" });
  });

  it("resolves enharmonic tonics", () => {
    // D# minor is spelled Eb minor on the flat side (6 flats).
    expect(keyCard("D#-").count).toBeGreaterThan(0);
  });

  it("returns a blank card for junk", () => {
    for (const k of [null, undefined, "", "xyz", "H"]) {
      expect(keyCard(k)).toEqual({ count: 0, suit: null, color: null });
    }
  });

  it("never reports more than 7 accidentals", () => {
    for (const k of [...MAJOR_KEYS, ...MINOR_KEYS.map((x) => `${x}-`)]) {
      expect(keyCard(k).count).toBeLessThanOrEqual(7);
    }
  });
});

describe("transposeKey", () => {
  it("is a no-op for zero semitones", () => {
    expect(transposeKey("Bb", 0)).toBe("Bb");
  });

  it("transposes up for a Bb instrument (concert + 2)", () => {
    // A tenor player reads a whole step up from concert.
    expect(transposeKey("C", 2)).toBe("D");
    expect(transposeKey("Bb", 2)).toBe("C");
    expect(transposeKey("Eb", 2)).toBe("F");
  });

  it("transposes up for an Eb instrument (concert + 9)", () => {
    expect(transposeKey("C", 9)).toBe("A");
    expect(transposeKey("Bb", 9)).toBe("G");
  });

  it("keeps the mode and uses minor spellings", () => {
    expect(transposeKey("A-", 3)).toBe("C-");
    expect(transposeKey("G-", 2)).toBe("A-");
    // C# minor, never Db minor
    expect(transposeKey("C-", 1)).toBe("C#-");
  });

  it("wraps around the octave", () => {
    expect(transposeKey("B", 1)).toBe("C");
    expect(transposeKey("C", 12)).toBe("C");
    expect(transposeKey("C", -1)).toBe("B");
  });

  it("passes through unparseable input rather than throwing", () => {
    expect(transposeKey("xyz", 2)).toBe("xyz");
    expect(transposeKey(null, 2)).toBeNull();
  });

  it("round-trips through a full octave for every key", () => {
    for (const k of MAJOR_KEYS) {
      expect(transposeKey(transposeKey(k, 5), 7)).toBe(k);
    }
  });
});

describe("toRelativeMajor", () => {
  it("moves a minor tonic up a minor third", () => {
    expect(toRelativeMajor("A-")).toBe("C");
    expect(toRelativeMajor("G-")).toBe("Bb");
    expect(toRelativeMajor("C-")).toBe("Eb");
    expect(toRelativeMajor("F#-")).toBe("A");
  });

  it("leaves major keys alone", () => {
    expect(toRelativeMajor("Bb")).toBe("Bb");
    expect(toRelativeMajor("C")).toBe("C");
  });

  it("handles missing input", () => {
    expect(toRelativeMajor(null)).toBeNull();
  });
});

describe("INSTRUMENTS", () => {
  it("covers the four instrument families with the right offsets", () => {
    const byId = Object.fromEntries(INSTRUMENTS.map((i) => [i.id, i.offset]));
    expect(byId).toEqual({ C: 0, Bb: 2, Eb: 9, F: 7 });
  });

  it("has unique ids", () => {
    expect(new Set(INSTRUMENTS.map((i) => i.id)).size).toBe(INSTRUMENTS.length);
  });
});
