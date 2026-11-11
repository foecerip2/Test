# Сборка из корня репозитория: docker build -f apps/autoflow-web/Dockerfile .
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
# Манифесты всех пакетов workspace нужны для --frozen-lockfile
COPY apps/web/package.json apps/web/
COPY apps/android/package.json apps/android/
COPY apps/autoflow-web/package.json apps/autoflow-web/
COPY apps/autoflow-android/package.json apps/autoflow-android/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY apps/autoflow-web apps/autoflow-web
# Публичные значения «зашиваются» в бандл при сборке (см. src/lib/config.ts)
ARG NEXT_PUBLIC_SITE_URL=https://autoflow.vaylonet.ru
ARG NEXT_PUBLIC_CONTACT_EMAIL=
ARG NEXT_PUBLIC_CONTACT_TELEGRAM=
ARG NEXT_PUBLIC_OPERATOR_NAME=
ARG NEXT_PUBLIC_API_MODE=live
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_CONTACT_EMAIL=$NEXT_PUBLIC_CONTACT_EMAIL \
    NEXT_PUBLIC_CONTACT_TELEGRAM=$NEXT_PUBLIC_CONTACT_TELEGRAM \
    NEXT_PUBLIC_OPERATOR_NAME=$NEXT_PUBLIC_OPERATOR_NAME \
    NEXT_PUBLIC_API_MODE=$NEXT_PUBLIC_API_MODE
ENV NEXT_TELEMETRY_DISABLED=1 NODE_OPTIONS=--max-old-space-size=1024
RUN pnpm --filter autoflow-web build

FROM node:22-alpine AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/autoflow-web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/autoflow-web/.next/static ./apps/autoflow-web/.next/static
COPY --from=build --chown=node:node /app/apps/autoflow-web/public ./apps/autoflow-web/public
USER node
EXPOSE 3000
CMD ["node", "apps/autoflow-web/server.js"]
