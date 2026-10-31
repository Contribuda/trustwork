# Trustwork web application image (OPS-002): Next standalone output, non-root, no devDependencies, tests or docs.
#   docker build -f infra/Dockerfile \
#     --build-arg NEXT_PUBLIC_BASE_PATH=/trustwork \
#     --build-arg NEXT_PUBLIC_SITE_URL=https://example.invalid/trustwork \
#     --build-arg NEXT_PUBLIC_TRUSTWORK_BRAND= \
#     --build-arg TRUSTWORK_ALLOWED_ORIGINS=example.invalid \
#     -t trustwork-web .
#   docker run -p 3000:3000 trustwork-web
# The app listens on PORT (default 3000) on every interface (IPv4 and IPv6, `::`). This file is the image the hosted
# preview builds (Railway reads it from infra/Dockerfile and passes service variables named like the ARGs below).
# Build-time values: NEXT_PUBLIC_* are inlined by Next, and the standalone server freezes next.config.ts at build
# time, so TRUSTWORK_ALLOWED_ORIGINS (server-action origins behind a proxy) and TRUSTWORK_API_ORIGIN (only for the
# optional /v1/* rewrite) are build arguments as well.
# NEXT_PUBLIC_TRUSTWORK_BRAND selects a deployment brand overlay from apps/web/brand (empty = neutral engine).
# Runtime values (docker run -e): PORT, TRUSTWORK_API_ORIGIN (server rendering; required unless TRUSTWORK_DEMO_MODE=1),
# TRUSTWORK_DEMO_MODE, TRUSTWORK_DEFAULT_COUNTRY, TRUSTWORK_CONFIG, TRUSTWORK_DATA_DIR, TRUSTWORK_DEMO_PERSONA, TRUSTWORK_HSTS.
# Other images (API, worker, migrate job) and the compose stack: docs/operations/images.md.
ARG NODE_IMAGE=node:24.18.0-alpine
ARG RUNTIME_IMAGE=alpine:3.24

FROM ${NODE_IMAGE} AS build
WORKDIR /src
ARG NEXT_PUBLIC_BASE_PATH=
ARG NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000
ARG NEXT_PUBLIC_TRUSTWORK_BRAND=
ARG TRUSTWORK_ALLOWED_ORIGINS=
# Read by next.config.ts for the same-origin /v1/* rewrite (WEB-004). Empty (default): no rewrite, the reverse proxy
# routes /v1/* (infra/proxy); demo deployments set TRUSTWORK_DEMO_MODE=1 at run time and never call the API.
ARG TRUSTWORK_API_ORIGIN=
ARG TRUSTWORK_DEMO_MODE=
# NEXT_PRIVATE_STANDALONE switches Next's default `output` to "standalone" without changing next.config.ts; the
# test after the build fails loudly if a Next upgrade stops honouring it.
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL NEXT_PUBLIC_TRUSTWORK_BRAND=$NEXT_PUBLIC_TRUSTWORK_BRAND \
    TRUSTWORK_ALLOWED_ORIGINS=$TRUSTWORK_ALLOWED_ORIGINS TRUSTWORK_API_ORIGIN=$TRUSTWORK_API_ORIGIN TRUSTWORK_DEMO_MODE=$TRUSTWORK_DEMO_MODE \
    NEXT_TELEMETRY_DISABLED=1 NEXT_PRIVATE_STANDALONE=1
COPY package.json package-lock.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund
RUN npm run build -w @trustwork/web \
 && test -f apps/web/.next/standalone/apps/web/server.js \
 && rm -rf apps/web/.next/standalone/apps/web/.next/cache
# Standalone output copies only traced files. Every directory the server reads with fs at run time is copied
# explicitly instead (paths resolve from the working directory, /app/apps/web; docs/operations/images.md lists them):
#   apps/web/locales/<tag>/<namespace>.json   language discovery and dictionaries (locale-data.ts, locale-negotiation.ts)
#   packages/ui/locales/<tag>.json            design-system dictionaries (locale-data.ts)
#   apps/web/fixtures                         demo content and its per-language overrides, fixtures/i18n (data/fixtures.ts)
#   packages/ui/media/artworks                /media/* (app/media/[...path]/route.ts)
# Country packs, the country list and brand messages are JSON imports that webpack bundles; they are copied as well so
# a later switch to reading them with fs cannot break the image. A deployment's own configuration file and data
# directory (TRUSTWORK_CONFIG, TRUSTWORK_DATA_DIR) are never baked in: they are mounted at run time.
RUN mkdir -p /stage/apps/web /stage/packages/ui/media /stage/packages/country-packs \
 && cp -R apps/web/.next/standalone/. /stage/ \
 && cp -R apps/web/.next/static /stage/apps/web/.next/static \
 && cp -R apps/web/public /stage/apps/web/public \
 && for dir in apps/web/locales apps/web/fixtures packages/ui/locales packages/ui/media/artworks packages/country-packs/packs packages/country-packs/countries; do \
      rm -rf "/stage/$dir" && cp -R "$dir" "/stage/$dir" || exit 1; \
    done \
 && find /stage/node_modules -type f \( -iname 'README*' -o -iname 'CHANGELOG*' -o -name '*.map' -o -name '*.d.ts' \) ! -iname 'LICEN[CS]E*' -delete \
 # Output tracing also copies TypeScript sources and notes it never loads (webpack bundled them); none ships.
 && find /stage -path /stage/node_modules -prune -o -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.md' \) -print -delete

FROM ${NODE_IMAGE} AS node
FROM ${RUNTIME_IMAGE}
ARG NEXT_PUBLIC_BASE_PATH=
RUN apk add --no-cache libstdc++ tini \
 && addgroup -g 1000 -S trustwork && adduser -u 1000 -S -G trustwork -H -h /app trustwork
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build /stage ./
USER 1000:1000
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 TRUSTWORK_LISTEN_HOST=:: \
    TRUSTWORK_HEALTH_PATH=${NEXT_PUBLIC_BASE_PATH}/icon.svg
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+process.env.TRUSTWORK_HEALTH_PATH).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/sbin/tini", "--"]
# Docker and some hosts set HOSTNAME to the container name; the standalone server binds to HOSTNAME, so it is set here.
CMD ["/bin/sh", "-c", "HOSTNAME=\"$TRUSTWORK_LISTEN_HOST\" exec node apps/web/server.js"]
