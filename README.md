# Tune Deck

Flick through a deck of cards and it deals you a jazz standard for the set.
Filter by feel and by obscurity/difficulty, randomize the key, weigh in on how
hard/obscure a tune felt (crowd scores improve over time), and open the chart
in iReal Pro.

Mobile-first web app. Built so a future iOS/Android app can reuse the backend
and core logic — see [CLAUDE.md](CLAUDE.md) for architecture.

## Stack

- **Backend**: Flask + SQLAlchemy + Postgres (SQLite locally), deployed on Fly.io
- **Frontend**: React + TypeScript + Vite (the card-swipe deck)
- **Data**: parsed from an iReal Pro backup export (1,600+ jazz tunes with
  composer, key, and feel) — metadata only, no copyrighted charts

## Local development

Backend (defaults to a local SQLite DB, auto-seeds on first run):

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
PYTHONPATH=. python -m app.web        # http://localhost:8080
```

Frontend (Vite dev server, proxies /api to :8080):

```bash
cd frontend
npm install
npm run dev                            # http://localhost:5173
```

## Rebuild the tune database

```bash
BOOKS=~/Documents/"Practice Stuff"/"real books"

# 1. (optional) parse the fake-book master index for chart references
pip install pypdf
python scripts/build_charts.py "$BOOKS"/MASTERNX.PDF

# 2. (optional) render book front covers into frontend/public/covers/
pip install pymupdf
python scripts/build_covers.py "$BOOKS"

# 3. parse the iReal Pro backup into data/tunes.json (canon scores + charts)
node scripts/build_seed.mjs ~/Downloads/"iReal Pro Backup 6-6-26.html"
```

`init_db()` upserts the seed on startup by a stable natural key, so re-seeding
never wipes crowd ratings. Chart references are book + page only — no chart
content is stored.

## Production build / Docker

```bash
docker build -t tune-deck .
docker run -p 8080:8080 tune-deck      # gunicorn, serves SPA + API
```

## Deploy (Fly.io)

Mirrors the Leif Bot pattern. Postgres is a separate Fly app; set
`DATABASE_URL` via `fly secrets`. Don't deploy without the owner's go-ahead.

```bash
fly deploy
```

## API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/api/tunes` | all tunes (client filters + picks locally) |
| GET  | `/api/meta` | feels + keys |
| POST | `/api/tunes/:id/pick` | record a draw (times_picked, last_picked_at) |
| POST | `/api/tunes/:id/played` | confirm the band played it (times_played, last_played_at) |
| POST | `/api/tunes/:id/key` | randomize key within the tune's mode, persist |
| POST | `/api/tunes/:id/rate` | submit a crowd weigh-in, returns refreshed scores |
