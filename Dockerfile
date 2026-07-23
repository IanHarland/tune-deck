# --- Stage 1: build the React/Vite frontend ---
FROM node:20-slim AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# --- Stage 2: Python/Flask backend serving the built SPA ---
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

# ORDER MATTERS: least-frequently-changed first. Docker's build cache is
# sequential, so a changed layer invalidates every layer BELOW it. books/ is
# ~935 MB and never changes, but it used to sit after `COPY app ./app` — which
# meant every single code deploy busted its cache and re-copied and re-hashed
# the whole 935 MB. Keep the big immutable payload above the churn.
#
# private fake-book PDFs (gitignored; present only in the owner's build context).
# app/fakebooks.py reads them from /app/books; an empty dir just leaves the
# reader dark (each book reports available:false).
COPY books ./books
COPY data ./data
# hand-made MusicXML charts (gitignored, like books/). init_db() imports them
# on boot; an empty dir just means no chart is transposable yet. Small, but it
# belongs above app/ so adding a chart doesn't rebuild anything expensive.
COPY charts ./charts
# --- everything below here changes on essentially every deploy ---
COPY app ./app
# built frontend lands where app/web.py expects it (../frontend/dist)
COPY --from=frontend /frontend/dist ./frontend/dist

# init_db() runs on import (creates tables + idempotent seed). 1 worker +
# threads keeps the footprint small on a shared-cpu-1x machine.
#
# --timeout back to 120 (was 900): the 11-minute vision transcription that
# needed the long window is gone. The slowest request now is extracting a tune's
# pages out of a 500 MB PDF, a few seconds cold.
CMD ["gunicorn", "-b", "0.0.0.0:8080", "-w", "1", "--threads", "4", \
     "--worker-class", "gthread", "--timeout", "120", "app.web:app"]

EXPOSE 8080
