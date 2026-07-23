# charts/ — hand-made MusicXML lead sheets

Drop MusicXML exports here and they become transposable charts in the app.
This folder is gitignored (it holds copyrighted chart content, same reasoning
as `books/`) but it IS copied into the Docker image, so a file here ships on
the next deploy.

## Workflow

1. Open the chart in Tune Deck. It downloads as
   `<Title> (<Book> p<Page>).pdf` — keep that name.
2. Scan that PDF in [Soundslice](https://www.soundslice.com/sheet-music-scanner/),
   fix whatever it misread **in their editor**, then export MusicXML.
3. Drop the file in here. The exporter's extra decoration is fine — a leading
   timestamp and a trailing `-1` are both stripped — as long as the
   `(<Book> p<Page>)` part survives.
4. `python -m app.chart_import` to check it locally, then deploy.

The file is matched to a tune by its `(<Book> p<Page>)` reference, not by
title, because that reference is exact. Every import is test-rendered in all 12
keys before it's stored, so a file that can't engrave is rejected loudly rather
than breaking the app later.

Charts land `verified=True` — the assumption is you corrected them in
Soundslice. Anything imported without that check should have the flag cleared.
