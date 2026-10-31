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
# time, so TRUSTWORK_ALLOWED_ORIGINS (server-action origins behind a proxy) must be a build argument as well.
# NEXT_PUBLIC_TRUSTWORK_BRAND selects a deployment brand overlay from apps/web/brand (empty = neutral engine).
# Runtime values (docker run -e): PORT, TRUSTWORK_DEFAULT_COUNTRY, TRUSTWORK_DEMO_PERSONA, TRUSTWORK_HSTS.
# Other images (API, worker, migrate job) and the compose stack: docs/operations/images.md.
ARG NODE_IMAGE=node:24.18.0-alpine
ARG RUNTIME_IMAGE=alpine:3.24

FROM ${NODE_IMAGE} AS build
WORKDIR /src
ARG NEXT_PUBLIC_BASE_PATH=
ARG NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000
ARG NEXT_PUBLIC_TRUSTWORK_BRAND=
ARG TRUSTWORK_ALLOWED_ORIGINS=
# NEXT_PRIVATE_STANDALONE switches Next's default `output` to "standalone" without changing next.config.ts; the
# test after the build fails loudly if a Next upgrade stops honouring it.
ENV NEXT_PUBLIC_BASE_PATH=$NEXT_PUBLIC_BASE_PATH NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL NEXT_PUBLIC_TRUSTWORK_BRAND=$NEXT_PUBLIC_TRUSTWORK_BRAND \
    TRUSTWORK_ALLOWED_ORIGINS=$TRUSTWORK_ALLOWED_ORIGINS NEXT_TELEMETRY_DISABLED=1 NEXT_PRIVATE_STANDALONE=1
COPY package.json package-lock.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund
RUN npm run build -w @trustwork/web \
 && test -f apps/web/.next/standalone/apps/web/server.js \
 && rm -rf apps/web/.next/standalone/apps/web/.next/cache
# Runtime file reads (apps/web/app/_lib/locale-data.ts and app/media/[...path]/route.ts) resolve these from the
# working directory, so they are copied explicitly instead of relying on output tracing.
RUN mkdir -p /stage/apps/web /stage/packages/ui/media \
 && cp -R apps/web/.next/standalone/. /stage/ \
 && cp -R apps/web/.next/static /stage/apps/web/.next/static \
 && cp -R apps/web/public /stage/apps/web/public \
 && rm -rf /stage/apps/web/locales /stage/packages/ui/locales \
 && cp -R apps/web/locales /stage/apps/web/locales \
 && cp -R packages/ui/locales /stage/packages/ui/locales \
 && cp -R packages/ui/media/artworks /stage/packages/ui/media/artworks \
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
