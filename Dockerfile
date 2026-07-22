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

COPY app ./app
COPY data ./data
# private fake-book PDFs (gitignored; present only in the owner's build context).
# app/fakebooks.py reads them from /app/books; an empty dir just leaves the
# reader dark (each book reports available:false).
COPY books ./books
# built frontend lands where app/web.py expects it (../frontend/dist)
COPY --from=frontend /frontend/dist ./frontend/dist

# init_db() runs on import (creates tables + idempotent seed). 1 worker +
# threads keeps the footprint small on a shared-cpu-1x machine.
#
# --timeout 900 (was 120) for chart transcription: a vision pass over a dense
# fake-book page measured 680 s, and at 120 s gunicorn killed the worker
# mid-request. It blocks one of the four threads while it runs, which is fine at
# one-user volume; if this ever gets busy — or if holding an 11-minute HTTP
# request proves flaky over the Fly proxy — move transcription to a background
# job and poll for the result instead.
CMD ["gunicorn", "-b", "0.0.0.0:8080", "-w", "1", "--threads", "4", \
     "--worker-class", "gthread", "--timeout", "900", "app.web:app"]

EXPOSE 8080
