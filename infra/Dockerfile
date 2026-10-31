# Trustwork web application container.
#   docker build -f infra/Dockerfile \
#     --build-arg NEXT_PUBLIC_BASE_PATH=/trustwork \
#     --build-arg NEXT_PUBLIC_SITE_URL=https://example.invalid/trustwork \
#     --build-arg NEXT_PUBLIC_TRUSTWORK_BRAND= \
#     -t trustwork-web .
#   docker run -p 3000:3000 -e TRUSTWORK_ALLOWED_ORIGINS=example.invalid trustwork-web
# The app listens on PORT (default 3000). NEXT_PUBLIC_* values are inlined at build time, so pass them as
# build arguments (Railway passes service variables with these names automatically).
# NEXT_PUBLIC_TRUSTWORK_BRAND selects a deployment brand overlay from apps/web/brand (empty = neutral engine).
FROM node:24.18.0-alpine AS build
WORKDIR /src
ARG NEXT_PUBLIC_BASE_PATH=
ARG NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000
ARG NEXT_PUBLIC_TRUSTWORK_BRAND=
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL NEXT_PUBLIC_TRUSTWORK_BRAND=$NEXT_PUBLIC_TRUSTWORK_BRAND NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund
RUN npm run build -w @trustwork/web

FROM node:24.18.0-alpine
WORKDIR /src
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=build /src ./
EXPOSE 3000
CMD ["sh", "-c", "node node_modules/next/dist/bin/next start apps/web --hostname :: --port ${PORT:-3000}"]
