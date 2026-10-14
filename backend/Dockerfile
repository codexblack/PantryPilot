# syntax=docker/dockerfile:1.7

FROM python:3.14.8-slim-bookworm@sha256:48b13b003dda20b16f9442b8475aa05fe21bf6579a8c881db92ffb4d8fd20f83

ARG APP_GID=10001
ARG APP_UID=10001

ENV HOME=/tmp \
    PATH=/usr/local/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    XDG_CACHE_HOME=/tmp/.cache

WORKDIR /app

RUN apt-get update \
    && apt-get install --no-install-recommends --yes libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid "${APP_GID}" pantrypilot \
    && useradd --uid "${APP_UID}" --gid "${APP_GID}" --no-create-home --shell /usr/sbin/nologin pantrypilot

COPY backend/requirements.txt backend/requirements.lock ./
RUN python -m pip install --no-cache-dir --requirement requirements.txt

COPY --chown=pantrypilot:pantrypilot backend/app ./app

USER pantrypilot

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"]

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--limit-concurrency", "8", "--backlog", "64"]
