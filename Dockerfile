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
CMD ["gunicorn", "-b", "0.0.0.0:8080", "-w", "1", "--threads", "4", \
     "--worker-class", "gthread", "--timeout", "120", "app.web:app"]

EXPOSE 8080
