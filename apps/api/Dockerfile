# Multi-Stage: API schlank (ohne Whisper), Worker mit Transkription.
# Worker auf Python 3.12: faster-whisper/ctranslate2 liefern dafuer stabile Wheels.

FROM python:3.14-slim AS api

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY apps/api/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY apps/api/app /app/app

EXPOSE 8000
# 2 Worker: Headroom fuer viele parallele Erfasser; --reload ist ein Dev-Werkzeug
# und gehoert nicht in den Standardbetrieb (Datei-Watching, einzelner Prozess).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]


FROM python:3.12-slim AS worker

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY apps/api/requirements.txt /app/requirements.txt
COPY apps/api/requirements-worker.txt /app/requirements-worker.txt
RUN pip install --no-cache-dir -r /app/requirements.txt -r /app/requirements-worker.txt

COPY apps/api/app /app/app

CMD ["python", "-m", "app.worker"]
