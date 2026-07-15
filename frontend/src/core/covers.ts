// Portable helper — no DOM/React, safe to copy into a future Expo app.
// Maps a fake-book title to its cover-image slug. MUST match scripts/
// build_covers.py slug() so the frontend finds the rendered cover thumbnail.
export function coverSlug(book: string): string {
  return book
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
