// Fake-book reader API client. The session cookie (set by /auth) is sent
// automatically on same-origin fetches, so nothing to pass around. Kept in core
// as plain fetch so a future native app can reuse it (swapping cookie for token).
import { API_BASE } from "./api";

export interface FakebookInfo {
  slug: string;
  // page-section -> offset (PDF_page = number + offset). "" is the main run of
  // pages; a letter key is a separately-numbered section, e.g. "A" for Real Book
  // Vol. 1's appendix (p.A1 = Alfie).
  offsets: Record<string, number>;
  available: boolean; // is the PDF actually uploaded
  // Transposed printings of this same book that are on disk, keyed "Bb"/"Eb".
  // Only present where the printing is page-aligned with the concert edition,
  // so the concert chart index still points at the right tune.
  editions: Record<string, { offsets: Record<string, number> }>;
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

// A printed page ref as the book prints it: a number, optionally prefixed by a
// section letter ("288", "A1"). Mirrors parse_page() in app/fakebooks.py.
export function parsePageRef(page: string | number): { section: string; number: number } | null {
  const m = /^([A-Za-z]?)([0-9]{1,4})$/.exec(String(page).trim());
  return m ? { section: m[1].toUpperCase(), number: parseInt(m[2], 10) } : null;
}

// Canonical token for the URL (uppercased section, no stray whitespace).
export function pageToken(page: string | number): string | null {
  const p = parsePageRef(page);
  return p ? `${p.section}${p.number}` : null;
}

// Can this book actually open this page? Needs the PDF present and a known
// offset for the page's section — a ref into a section we can't locate would
// otherwise look tappable and do nothing.
export function canOpenPage(info: FakebookInfo | undefined, page: string | number): boolean {
  const p = parsePageRef(page);
  return !!(info?.available && p && p.section in info.offsets);
}

// Which printing this ref will actually open for a player on `instrument`.
// "" means concert pitch — either the instrument is in C (or F, for which we
// stock no books), this book has no transposed printing, or it has one that
// doesn't cover this page's section (Real Book Vol. 1's A-appendix). Falling
// back is fine; silently *claiming* to be transposed would not be, so callers
// show a badge only for a non-empty result.
export function editionFor(
  info: FakebookInfo | undefined,
  page: string | number,
  instrument: string | null | undefined,
): string {
  if (!info || !instrument || instrument === "C") return "";
  const ed = info.editions?.[instrument];
  const p = parsePageRef(page);
  return ed && p && p.section in ed.offsets ? instrument : "";
}

// One-tune PDF (the chart's page(s), offset + multi-page span applied server-side).
// Opened as its own page so its native share can hand it to forScore.
export function fakebookTuneUrl(
  slug: string,
  printedPage: string | number,
  edition = "",
): string {
  const q = edition ? `?edition=${encodeURIComponent(edition)}` : "";
  return `${API_BASE}/api/fakebook/${slug}/tune-p${pageToken(printedPage)}.pdf${q}`;
}
