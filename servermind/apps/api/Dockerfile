# syntax=docker/dockerfile:1
# Контекст сборки — каталог servermind/ (docker build -f apps/api/Dockerfile .). Образ собирается в CI, не на VPS.
FROM python:3.12-slim AS deps
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /w
COPY apps/api/requirements.txt .
RUN python -m venv /opt/venv && /opt/venv/bin/pip install -r requirements.txt

FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH=/opt/venv/bin:$PATH
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin servermind
WORKDIR /app
COPY --from=deps /opt/venv /opt/venv
COPY apps/api/app ./app
COPY apps/api/alembic ./alembic
COPY apps/api/alembic.ini ./alembic.ini

# Пакет развёртывания едет ВМЕСТЕ с образом: установщик/автообновление достают его из образа, поэтому конфигурация
# (compose, Caddy, update.sh) всегда соответствует версии кода. release.json фиксирует неизменяемый digest веб-образа.
COPY infra /app/deploy/infra
COPY bootstrap /app/deploy/bootstrap
ARG WEB_IMAGE=""
ARG GIT_SHA="unknown"
RUN printf '{"commit":"%s","web":"%s"}\n' "$GIT_SHA" "$WEB_IMAGE" > /app/deploy/release.json

USER 10001
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3).status == 200 else 1)"]
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
