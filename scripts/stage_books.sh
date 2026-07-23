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

# "source filename in SRC|destination filename in books/" — the destination is
# what app/fakebooks.py BOOKS refers to. Concert editions keep their names; the
# transposed printings are renamed to drop spaces.
#
# The B♭/E♭ editions are only listed for books whose transposed printing is
# PAGE-ALIGNED with the concert one (the three Real Books). The New Real Book
# B♭ editions are paginated differently, so the concert chart index would point
# at the wrong tune — see the note in app/fakebooks.py BOOKS.
files=(
  "REALBK1.PDF|REALBK1.PDF"     "JAZZFAKE.PDF|JAZZFAKE.PDF"
  "REALBK2.PDF|REALBK2.PDF"     "JAZZLTD.PDF|JAZZLTD.PDF"
  "REALBK3.PDF|REALBK3.PDF"     "NEWREAL1.PDF|NEWREAL1.PDF"
  "NEWREAL2.PDF|NEWREAL2.PDF"   "nrealbk3.pdf|NEWREAL3.PDF"
  "LIBRARY.PDF|LIBRARY.PDF"     "COLOBK.PDF|COLOBK.PDF"
  "EVANSBK.PDF|EVANSBK.PDF"
  "Real Book Bb 5th Edition.pdf|REALBK1_BB.PDF"
  "Real Book Eb Vol 1.pdf|REALBK1_EB.PDF"
  "Real Book Bb Volume 2.pdf|REALBK2_BB.PDF"
  "Real Book Eb Vol 2.pdf|REALBK2_EB.PDF"
  "Real Book Bb Volume 3.pdf|REALBK3_BB.PDF"
)

echo "Source: $SRC"
echo "Dest:   $DEST"
missing=0
for entry in "${files[@]}"; do
  f="${entry%%|*}"
  dest="${entry##*|}"
  src="$SRC/$f"
  if [ ! -f "$src" ]; then
    echo "  MISSING: $f  (check the filename / edition in $SRC)"
    missing=$((missing + 1))
    continue
  fi
  echo "  materializing + copying $f …"
  brctl download "$src" 2>/dev/null || true   # pull the iCloud placeholder down
  cp "$src" "$DEST/$dest"
  echo "    -> books/$dest ($(du -h "$DEST/$dest" | cut -f1))"
done

echo
echo "Done. books/ holds the referenced fake books (gitignored)."
[ "$missing" -gt 0 ] && echo "NOTE: $missing file(s) missing — rename/point them and re-run."
exit 0
