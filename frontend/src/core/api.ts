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

export function markPlayed(tuneId: string): Promise<Tune> {
  return req(`/api/tunes/${tuneId}/played`, { method: "POST" });
}

export function randomizeKey(
  tuneId: string,
): Promise<{ last_played_key: string }> {
  return req(`/api/tunes/${tuneId}/key`, { method: "POST" });
}

export function deleteTune(tuneId: string): Promise<{ ok: boolean }> {
  return req(`/api/tunes/${tuneId}`, { method: "DELETE" });
}

export function submitRating(
  tuneId: string,
  ratings: { obscurity?: number; difficulty?: number },
  anonymousUserId?: string,
): Promise<Tune> {
  return req<Tune>(`/api/tunes/${tuneId}/rate`, {
    method: "POST",
    body: JSON.stringify({ ...ratings, anonymous_user_id: anonymousUserId }),
  });
}
