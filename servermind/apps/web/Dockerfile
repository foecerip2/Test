# syntax=docker/dockerfile:1
# Контекст сборки — каталог servermind/ (docker build -f apps/web/Dockerfile .). Образ собирается в CI, не на VPS (экономия RAM).
FROM node:22-alpine AS deps
WORKDIR /w
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /w
COPY --from=deps /w/node_modules ./node_modules
COPY apps/web ./
# Адрес API внутри docker-сети подставляется при СБОРКЕ (rewrites). Dev-фикстуры в production не попадают.
ARG API_BASE_URL=http://api:8000
ENV API_BASE_URL=$API_BASE_URL NEXT_PUBLIC_DEV_FIXTURES=0 NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /w/.next/standalone ./
COPY --from=build --chown=node:node /w/.next/static ./.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
