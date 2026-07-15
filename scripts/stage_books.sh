#!/usr/bin/env bash
# Stage the fake-book PDFs into ./books so the Docker build can embed them.
# Copies (force-downloading from iCloud if needed) ONLY the 11 books the chart
# index references — not the whole ~2 GB library.
#
# Usage: scripts/stage_books.sh ["/path/to/real books"]
#   defaults to the iCloud "real books" folder.
set -euo pipefail

SRC="${1:-$HOME/Documents/Practice Stuff/real books}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/books"
mkdir -p "$DEST"

# filename in SRC  ->  the display name it maps to (see app/fakebooks.py BOOKS).
files=(
  "REALBK1.PDF"   "JAZZFAKE.PDF"  "JAZZLTD.PDF"
  "REALBK2.PDF"   "REALBK3.PDF"   "NEWREAL1.PDF"
  "NEWREAL2.PDF"  "NEWREAL3.PDF"  "LIBRARY.PDF"
  "COLOBK.PDF"    "EVANSBK.PDF"
)

echo "Source: $SRC"
echo "Dest:   $DEST"
missing=0
for f in "${files[@]}"; do
  src="$SRC/$f"
  if [ ! -f "$src" ]; then
    echo "  MISSING: $f  (check the filename / edition in $SRC)"
    missing=$((missing + 1))
    continue
  fi
  echo "  materializing + copying $f …"
  brctl download "$src" 2>/dev/null || true   # pull the iCloud placeholder down
  cp "$src" "$DEST/$f"
  echo "    -> books/$f ($(du -h "$DEST/$f" | cut -f1))"
done

echo
echo "Done. books/ holds the referenced fake books (gitignored)."
[ "$missing" -gt 0 ] && echo "NOTE: $missing file(s) missing — rename/point them and re-run."
exit 0
