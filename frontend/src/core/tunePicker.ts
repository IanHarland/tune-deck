// Portable tune-selection logic. No DOM/React — copy into Expo unchanged.
//
// Feel is a HARD filter (a tune must match a selected feel to be in the deck).
// The obscurity/difficulty sliders are SOFT filters: they don't remove tunes,
// they only bias which tune gets drawn. Each slider is a TARGET (bullseye) —
// tunes whose score is near the slider value are most likely, and likelihood
// falls off with distance in either direction (but never to zero). So the
// extremes are reachable by sliding to 0 or 100, and the middle favors middling
// tunes.

import type { Filters, Mode, Tune } from "./types";

// Width of the preference bell curve (in score points). Intentionally wide /
// fuzzy: the slider is a lean, not a laser. At SPREAD=25, aiming at 50 still
// gives a tune at 25 (distance 25) ~61% relative weight; distance 50 ~14%.
// Bigger = fuzzier blast radius.
const SPREAD = 25;

// "Freshness" penalty so over-played / recently-played tunes surface less.
// Driven by times_played (persistent) and last_played_at (recovers over days).
// Soft — floored so a tune is never fully excluded.
const VOLUME_HALF = 40; // plays at which the volume weight is halved (gentle:
// total play count should barely affect whether a tune shows up — recency does
// the heavy lifting for "don't repeat what we just played")
const RECENCY_HALFLIFE_DAYS = 7; // how fast a recent play "cools off"
const RECENCY_MAX_PENALTY = 0.9; // weight of a tune played seconds ago: 1-0.9
const PLAY_FLOOR = 0.15; // minimum freshness weight

export function feelMatches(tune: Tune, feels: Filters["feels"]): boolean {
  return (
    feels.length === 0 ||
    feels.includes(tune.feel) ||
    tune.additional_feels.some((f) => feels.includes(f))
  );
}

export function isHenny(tune: Tune): boolean {
  return (tune.composer ?? "").trim().toLowerCase() === "joe henderson";
}

/** The deck: tunes passing the hard filters (feel + the Henny exclusion).
 * Drives the on-screen count. */
export function deckTunes(tunes: Tune[], filters: Filters): Tune[] {
  return tunes.filter(
    (t) =>
      feelMatches(t, filters.feels) && !(filters.excludeHenny && isHenny(t)),
  );
}

/** Target weight in (0, 1]: 1 at the slider value, tapering with distance.
 * A null target means the slider is OFF — no bias. */
function targetWeight(score: number, target: number | null): number {
  if (target == null) return 1;
  const d = score - target;
  return Math.exp(-(d * d) / (2 * SPREAD * SPREAD));
}

/** Hipness bullseye: bias by the 5★ crowd rating, mapped onto the 0–100 slider
 * (1★→0, 5★→100). An unrated tune is treated as a middling 3★ (→50) so the
 * slider still biases the (currently large) unrated majority. */
function hipnessWeight(tune: Tune, target: number | null): number {
  if (target == null) return 1;
  const stars = tune.rating_score ?? 3;
  return targetWeight(((stars - 1) / 4) * 100, target);
}

// Beginner mode draws ONLY from the beginner canon and never anything obscure.
// It's a hard pool (see beginnerPool / pickRandomTune), not a soft lean, so the
// obscurity slider can't pull an obscure tune in. The tag has one high-obscurity
// outlier (I Remember You), so we also cap obscurity at the canon edge (45).
const BEGINNER_OBSCURITY_MAX = 45;

/** The beginner-mode pool: easy canon only, nothing obscure. */
export function beginnerPool(tunes: Tune[]): Tune[] {
  return tunes.filter(
    (t) => t.tags.includes("beginner") && t.obscurity_score < BEGINNER_OBSCURITY_MAX,
  );
}

/** Mode lean: "hard" is a soft lean toward the difficult tunes (not a hard
 * filter). Beginner is handled as a hard pool, not here. */
function modeWeight(tune: Tune, mode: Mode): number {
  if (mode === "hard") return tune.tags.includes("hard") ? 1 : 0.05;
  return 1;
}

/** Freshness weight in [PLAY_FLOOR, 1]: lower for tunes played a lot and/or
 * recently. Recency recovers over days; volume is a gentle persistent nudge. */
export function freshnessWeight(tune: Tune, now: number = Date.now()): number {
  const volume = 1 / (1 + (tune.times_played || 0) / VOLUME_HALF);
  let recency = 1;
  if (tune.last_played_at) {
    const ageMs = now - Date.parse(tune.last_played_at);
    if (ageMs >= 0) {
      const ageDays = ageMs / 86_400_000;
      recency = 1 - RECENCY_MAX_PENALTY * Math.exp(-ageDays / RECENCY_HALFLIFE_DAYS);
    }
  }
  return Math.max(PLAY_FLOOR, volume * recency);
}

export function tuneWeight(
  tune: Tune,
  filters: Filters,
  now?: number,
  mode: Mode = "normal",
): number {
  return (
    targetWeight(
      tune.obscurity_score,
      filters.obscurityOn ? filters.obscurity : null,
    ) *
    targetWeight(
      tune.difficulty_score,
      filters.difficultyOn ? filters.difficulty : null,
    ) *
    hipnessWeight(tune, filters.hipnessOn ? filters.hipness : null) *
    freshnessWeight(tune, now) *
    modeWeight(tune, mode)
  );
}

/**
 * Draw a tune: hard-filter by feel, then pick weighted by the soft sliders.
 * `excludeIds` are tunes already suggested this round and skipped — until the
 * matching pool is exhausted, at which point we cycle (ignore the exclusions).
 */
export function pickRandomTune(
  tunes: Tune[],
  filters: Filters,
  excludeIds?: Set<string>,
  mode: Mode = "normal",
): Tune | null {
  const base = deckTunes(tunes, filters);
  // beginner mode hard-restricts to the easy, non-obscure canon
  const pool = mode === "beginner" ? beginnerPool(base) : base;
  if (pool.length === 0) return null;

  const remaining =
    excludeIds && excludeIds.size
      ? pool.filter((t) => !excludeIds.has(t.id))
      : pool;
  // once every matching tune has been suggested, start a fresh cycle
  const choose = remaining.length > 0 ? remaining : pool;

  const now = Date.now();
  const weights = choose.map((t) => tuneWeight(t, filters, now, mode));
  const total = weights.reduce((a, b) => a + b, 0);
  // If every weight underflowed (extreme slider vs. extreme pool), go uniform.
  if (total <= 0) return choose[Math.floor(Math.random() * choose.length)];

  let r = Math.random() * total;
  for (let i = 0; i < choose.length; i++) {
    r -= weights[i];
    if (r <= 0) return choose[i];
  }
  return choose[choose.length - 1];
}
