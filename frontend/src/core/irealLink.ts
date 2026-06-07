// Portable iReal Pro deep-link helper.
//
// Each tune carries its full single-song `irealb://` URL (built in the seed
// pipeline from the owner's backup). Opening it launches iReal Pro to that
// exact song in its ORIGINAL key — the key is baked into the chart data, so we
// can't transpose via the URL. See CLAUDE.md.

import type { Tune } from "./types";

export function irealUrlFor(tune: Tune): string | null {
  return tune.ireal_url ?? null;
}

export function canOpenInIreal(tune: Tune): boolean {
  return Boolean(tune.ireal_url);
}
