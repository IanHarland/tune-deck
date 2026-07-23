// core/tunePicker.ts — what actually gets drawn.
//
// The design rule that most of these tests defend: feel is a HARD filter, the
// sliders are SOFT. A slider must never make a tune impossible, only unlikely —
// otherwise the deck dead-ends at the extremes. Beginner mode is the one
// deliberate exception (a hard pool), so the obscurity slider can't drag an
// obscure tune into a beginner's set.
import { describe, expect, it } from "vitest";
import type { Filters, Tune } from "../types";
import {
  beginnerPool,
  deckTunes,
  feelMatches,
  freshnessWeight,
  isHenny,
  pickRandomTune,
  tuneWeight,
} from "../tunePicker";

let seq = 0;
const tune = (over: Partial<Tune> = {}): Tune =>
  ({
    id: `t${++seq}`,
    title: "Test Tune",
    alternate_titles: [],
    composer: "Someone",
    original_key: "C",
    last_played_key: null,
    feel: "medium_swing",
    additional_feels: [],
    ireal_style: null,
    ireal_url: null,
    time_signature: "4/4",
    charts: [],
    tags: [],
    obscurity_score: 50,
    difficulty_score: 50,
    obscurity_votes: 0,
    difficulty_votes: 0,
    rating_score: 50,
    rating_votes: 0,
    times_picked: 0,
    times_played: 0,
    last_picked_at: null,
    last_played_at: null,
    ...over,
  }) as Tune;

const filters = (over: Partial<Filters> = {}): Filters => ({
  feels: [],
  obscurity: 50,
  difficulty: 50,
  hipness: 50,
  obscurityOn: false,
  difficultyOn: false,
  hipnessOn: false,
  excludeHenny: false,
  ...over,
});

describe("feelMatches", () => {
  it("matches everything when no feel is selected", () => {
    expect(feelMatches(tune({ feel: "ballad" }), [])).toBe(true);
  });

  it("matches the primary feel", () => {
    expect(feelMatches(tune({ feel: "ballad" }), ["ballad"])).toBe(true);
    expect(feelMatches(tune({ feel: "ballad" }), ["up"])).toBe(false);
  });

  it("matches an additional feel", () => {
    // Medium Up Swing is tagged up + medium_swing.
    const t = tune({ feel: "up", additional_feels: ["medium_swing"] });
    expect(feelMatches(t, ["medium_swing"])).toBe(true);
  });
});

describe("isHenny", () => {
  it("identifies Joe Henderson case- and space-insensitively", () => {
    expect(isHenny(tune({ composer: "Joe Henderson" }))).toBe(true);
    expect(isHenny(tune({ composer: "  joe henderson " }))).toBe(true);
    expect(isHenny(tune({ composer: "Joe Zawinul" }))).toBe(false);
    expect(isHenny(tune({ composer: null }))).toBe(false);
  });
});

describe("deckTunes", () => {
  it("hard-filters by feel", () => {
    const pool = [tune({ feel: "ballad" }), tune({ feel: "up" })];
    expect(deckTunes(pool, filters({ feels: ["ballad"] }))).toHaveLength(1);
  });

  it("applies the Henny exclusion", () => {
    const pool = [tune({ composer: "Joe Henderson" }), tune({ composer: "Wayne Shorter" })];
    expect(deckTunes(pool, filters({ excludeHenny: true }))).toHaveLength(1);
    expect(deckTunes(pool, filters({ excludeHenny: false }))).toHaveLength(2);
  });
});

describe("tuneWeight", () => {
  it("is uniform when every slider is off", () => {
    const a = tune({ obscurity_score: 0 });
    const b = tune({ obscurity_score: 100 });
    expect(tuneWeight(a, filters(), 0)).toBeCloseTo(tuneWeight(b, filters(), 0));
  });

  it("peaks at the slider value", () => {
    const f = filters({ obscurityOn: true, obscurity: 20 });
    const onTarget = tuneWeight(tune({ obscurity_score: 20 }), f, 0);
    const near = tuneWeight(tune({ obscurity_score: 35 }), f, 0);
    const far = tuneWeight(tune({ obscurity_score: 90 }), f, 0);
    expect(onTarget).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(far);
  });

  it("never reaches zero — a slider is a lean, not a filter", () => {
    const f = filters({ obscurityOn: true, obscurity: 0 });
    expect(tuneWeight(tune({ obscurity_score: 100 }), f, 0)).toBeGreaterThan(0);
  });

  it("suppresses unrated tunes more as the hipness slider gets extreme", () => {
    const unrated = tune({ rating_votes: 0, rating_score: 50 });
    const neutral = tuneWeight(unrated, filters({ hipnessOn: true, hipness: 50 }), 0);
    const extreme = tuneWeight(unrated, filters({ hipnessOn: true, hipness: 100 }), 0);
    expect(neutral).toBeGreaterThan(extreme);
    expect(extreme).toBeGreaterThan(0); // floored, for discovery
  });

  it("does not suppress a rated tune that matches the hipness target", () => {
    const rated = tune({ rating_votes: 12, rating_score: 95 });
    const unrated = tune({ rating_votes: 0, rating_score: 50 });
    const f = filters({ hipnessOn: true, hipness: 95 });
    expect(tuneWeight(rated, f, 0)).toBeGreaterThan(tuneWeight(unrated, f, 0));
  });

  it("leans toward tagged tunes in hard mode without excluding others", () => {
    const hard = tune({ tags: ["hard"] });
    const easy = tune({ tags: [] });
    expect(tuneWeight(hard, filters(), 0, "hard")).toBeGreaterThan(
      tuneWeight(easy, filters(), 0, "hard"),
    );
    expect(tuneWeight(easy, filters(), 0, "hard")).toBeGreaterThan(0);
  });
});

describe("freshnessWeight", () => {
  const NOW = Date.parse("2026-07-23T00:00:00Z");

  it("is 1 for a never-played tune", () => {
    expect(freshnessWeight(tune(), NOW)).toBeCloseTo(1);
  });

  it("penalises a tune played moments ago", () => {
    const justPlayed = tune({ last_played_at: new Date(NOW - 1000).toISOString() });
    expect(freshnessWeight(justPlayed, NOW)).toBeLessThan(0.3);
  });

  it("recovers over days", () => {
    const recent = tune({ last_played_at: new Date(NOW - 86_400_000).toISOString() });
    const old = tune({ last_played_at: new Date(NOW - 30 * 86_400_000).toISOString() });
    expect(freshnessWeight(old, NOW)).toBeGreaterThan(freshnessWeight(recent, NOW));
  });

  it("nudges gently on total play count", () => {
    const played = tune({ times_played: 40 });
    expect(freshnessWeight(played, NOW)).toBeCloseTo(0.5, 1);
  });

  it("never drops to zero", () => {
    const hammered = tune({
      times_played: 10_000,
      last_played_at: new Date(NOW).toISOString(),
    });
    expect(freshnessWeight(hammered, NOW)).toBeGreaterThan(0);
  });

  it("ignores a future timestamp rather than inverting the penalty", () => {
    const future = tune({ last_played_at: new Date(NOW + 86_400_000).toISOString() });
    expect(freshnessWeight(future, NOW)).toBeCloseTo(1);
  });
});

describe("beginnerPool", () => {
  it("keeps tagged, non-obscure tunes", () => {
    const pool = [
      tune({ tags: ["beginner"], obscurity_score: 10 }),
      tune({ tags: ["beginner"], obscurity_score: 80 }), // I Remember You outlier
      tune({ tags: [], obscurity_score: 5 }),
    ];
    expect(beginnerPool(pool)).toHaveLength(1);
  });
});

describe("pickRandomTune", () => {
  it("returns null on an empty pool", () => {
    expect(pickRandomTune([], filters())).toBeNull();
  });

  it("returns null when the feel filter matches nothing", () => {
    expect(pickRandomTune([tune({ feel: "up" })], filters({ feels: ["waltz"] }))).toBeNull();
  });

  it("always returns a tune from the filtered deck", () => {
    const pool = [tune({ feel: "ballad" }), tune({ feel: "up" })];
    for (let i = 0; i < 50; i++) {
      expect(pickRandomTune(pool, filters({ feels: ["ballad"] }))!.feel).toBe("ballad");
    }
  });

  it("skips already-suggested tunes", () => {
    const a = tune();
    const b = tune();
    for (let i = 0; i < 30; i++) {
      expect(pickRandomTune([a, b], filters(), new Set([a.id]))!.id).toBe(b.id);
    }
  });

  it("cycles once every tune has been suggested", () => {
    const a = tune();
    expect(pickRandomTune([a], filters(), new Set([a.id]))!.id).toBe(a.id);
  });

  it("restricts beginner mode to the easy canon as a HARD pool", () => {
    const easy = tune({ tags: ["beginner"], obscurity_score: 5 });
    const obscure = tune({ tags: [], obscurity_score: 99 });
    // Slider pushed hard at obscure, but beginner mode must not yield it.
    const f = filters({ obscurityOn: true, obscurity: 100 });
    for (let i = 0; i < 50; i++) {
      expect(pickRandomTune([easy, obscure], f, undefined, "beginner")!.id).toBe(easy.id);
    }
  });

  it("returns null when beginner mode has nothing to draw", () => {
    expect(pickRandomTune([tune({ tags: [] })], filters(), undefined, "beginner")).toBeNull();
  });

  it("still returns a tune when every weight underflows", () => {
    // Extreme slider against an extreme pool can drive all weights to 0;
    // the picker must fall back to uniform rather than returning null.
    const pool = [tune({ obscurity_score: 100 }), tune({ obscurity_score: 100 })];
    const f = filters({
      obscurityOn: true, obscurity: 0,
      difficultyOn: true, difficulty: 0,
      hipnessOn: true, hipness: 0,
    });
    for (let i = 0; i < 20; i++) {
      expect(pickRandomTune(pool, f)).not.toBeNull();
    }
  });

  it("biases toward the slider target over many draws", () => {
    const near = tune({ obscurity_score: 10 });
    const far = tune({ obscurity_score: 95 });
    const f = filters({ obscurityOn: true, obscurity: 10 });
    let nearCount = 0;
    for (let i = 0; i < 400; i++) {
      if (pickRandomTune([near, far], f)!.id === near.id) nearCount++;
    }
    expect(nearCount).toBeGreaterThan(300); // strong lean, not a guarantee
  });

  it("can still reach a far tune — the slider never excludes", () => {
    const near = tune({ obscurity_score: 10 });
    const far = tune({ obscurity_score: 95 });
    const f = filters({ obscurityOn: true, obscurity: 10 });
    const ids = new Set(
      Array.from({ length: 2000 }, () => pickRandomTune([near, far], f)!.id),
    );
    expect(ids.has(far.id)).toBe(true);
  });
});
