// Fake-book reader API client. The session cookie (set by /auth) is sent
// automatically on same-origin fetches, so nothing to pass around. Kept in core
// as plain fetch so a future native app can reuse it (swapping cookie for token).
import { API_BASE } from "./api";

export interface FakebookInfo {
  slug: string;
  offset: number; // PDF_page = printed_page + offset
  available: boolean; // is the PDF actually uploaded
}

export interface FakebookMeta {
  configured: boolean; // is a password set at all
  authed: boolean; // does the caller already hold the cookie
  books: Record<string, FakebookInfo>; // keyed by display name (== chart.book)
}

export async function getFakebookMeta(): Promise<FakebookMeta> {
  const res = await fetch(`${API_BASE}/api/fakebook/meta`);
  if (!res.ok) throw new Error(`fakebook meta ${res.status}`);
  return res.json();
}

// Throws "wrong-password" (403) or "not-configured" (503) for the UI to branch on.
export async function authFakebook(password: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/fakebook/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.status === 403) throw new Error("wrong-password");
  if (res.status === 503) throw new Error("not-configured");
  if (!res.ok) throw new Error(`fakebook auth ${res.status}`);
}

export function fakebookPdfUrl(slug: string): string {
  return `${API_BASE}/api/fakebook/${slug}.pdf`;
}
