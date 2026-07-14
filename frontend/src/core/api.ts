// Portable API client. Uses fetch (available in browsers and React Native).
// Kept pure: anonymousUserId is passed in, not read from web-only storage, so
// this module copies into Expo unchanged.

import type { Tune } from "./types";

// Same-origin in prod (Flask serves the SPA); Vite proxies /api in dev.
// A future native app sets API_BASE to the deployed Fly URL.
export const API_BASE = "";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(`${res.status} ${path}: ${detail}`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

// The backend scales to zero: a cold open waits ~15–20s for the machine to wake
// and can briefly 5xx / drop the connection while Postgres resumes. Retry those
// transient failures with backoff so the app keeps showing its loading screen
// instead of dead-ending on the first blip. A real 4xx is not retried.
export async function getTunes(): Promise<Tune[]> {
  const delays = [800, 1500, 2500, 4000, 6000, 8000]; // + first try ≈ 23s budget
  for (let attempt = 0; ; attempt++) {
    try {
      return await req<Tune[]>("/api/tunes");
    } catch (e) {
      const status = (e as { status?: number }).status;
      const transient =
        status === undefined || status >= 500 || status === 408 || status === 429;
      if (!transient || attempt >= delays.length) throw e;
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
}

export function recordPick(tuneId: string): Promise<Tune> {
  return req(`/api/tunes/${tuneId}/pick`, { method: "POST" });
}

export function markPlayed(tuneId: string, key?: string | null): Promise<Tune> {
  return req(`/api/tunes/${tuneId}/played`, {
    method: "POST",
    body: JSON.stringify({ key: key ?? null }),
  });
}

export function randomizeKey(tuneId: string): Promise<{ key: string }> {
  return req(`/api/tunes/${tuneId}/key`, { method: "POST" });
}

export function deleteTune(tuneId: string): Promise<{ ok: boolean }> {
  return req(`/api/tunes/${tuneId}`, { method: "DELETE" });
}

// one swipe/tap: like/dislike and/or an obscurity/difficulty nudge, in one row.
// Returns the refreshed tune + the rating id (for undo).
export function castVote(
  tuneId: string,
  vote: { liked?: boolean | null; obscurity?: number | null; difficulty?: number | null },
  anonymousUserId?: string,
): Promise<{ tune: Tune; rating_id: string }> {
  return req(`/api/tunes/${tuneId}/vote`, {
    method: "POST",
    body: JSON.stringify({ ...vote, anonymous_user_id: anonymousUserId }),
  });
}

// undo a swipe — deletes the vote, returns the re-aggregated tune
export function undoVote(ratingId: string): Promise<Tune> {
  return req(`/api/ratings/${ratingId}`, { method: "DELETE" });
}
