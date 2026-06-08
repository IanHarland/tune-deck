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
    throw new Error(`${res.status} ${path}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

export function getTunes(): Promise<Tune[]> {
  return req<Tune[]>("/api/tunes");
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
