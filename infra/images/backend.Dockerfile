# Trustwork API, worker and one-shot migrate job (OPS-002). One Dockerfile, three final images:
#   docker build -f infra/images/backend.Dockerfile --target api     -t trustwork-api .
#   docker build -f infra/images/backend.Dockerfile --target worker  -t trustwork-worker .
#   docker build -f infra/images/backend.Dockerfile --target migrate -t trustwork-migrate .
# Without --target the build argument TRUSTWORK_IMAGE (api | worker | migrate, default api) selects the image, for
# hosts that cannot pass a target (Railway passes service variables declared as ARG). Nothing secret is baked in:
# every connection string, key and origin is runtime configuration (docs/operations/images.md).
# Each image holds compiled JavaScript, production dependencies of the workspaces it runs and nothing else: no
# TypeScript sources, tests, docs, tsx, npm or yarn. It runs as uid/gid 1000 under tini (signals reach Node).
ARG NODE_IMAGE=node:24.18.0-alpine
ARG RUNTIME_IMAGE=alpine:3.24
ARG TRUSTWORK_IMAGE=api

# ---------- build: compile the backend tree once ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
# Root devDependencies (typescript, @types/node) plus the backend workspaces; skips the web, Storybook and browser tooling.
RUN npm ci --no-audit --no-fund --ignore-scripts --omit=optional \
      --include-workspace-root -w @trustwork/api -w @trustwork/worker -w @trustwork/data -w @trustwork/contracts -w @trustwork/country-packs
COPY infra/images ./infra/images
RUN npx tsc -p infra/images/tsconfig.backend.json \
 # kernel.ts loads the country packs by URL with a .ts extension; Node's type stripping loads this one-line re-export.
 && printf "export * from './index.js';\n" > .image-build/packages/country-packs/src/index.ts

# ---------- production dependencies, one set per image ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/compliance/package.json packages/compliance/
COPY packages/contracts/package.json packages/contracts/
COPY packages/country-packs/package.json packages/country-packs/
COPY packages/data/package.json packages/data/
COPY packages/i18n-runtime/package.json packages/i18n-runtime/
COPY packages/ui/package.json packages/ui/
COPY infra/images/prune-modules.sh /usr/local/bin/prune-modules
RUN for set in "api:@trustwork/api @trustwork/data @trustwork/contracts" \
               "worker:@trustwork/worker @trustwork/data @trustwork/contracts" \
               "migrate:@trustwork/data @trustwork/contracts @trustwork/country-packs"; do \
      name="${set%%:*}"; flags=""; for ws in ${set#*:}; do flags="$flags -w $ws"; done; \
      npm ci --no-audit --no-fund --omit=dev --ignore-scripts $flags \
      && rm -rf node_modules/@trustwork node_modules/.package-lock.json \
      && sh /usr/local/bin/prune-modules node_modules \
      && mkdir -p "/out/$name" && mv node_modules "/out/$name/node_modules" || exit 1; \
    done

# ---------- runtime base: Node binary on plain Alpine, no package managers ----------
FROM ${NODE_IMAGE} AS node
FROM ${RUNTIME_IMAGE} AS runtime
RUN apk add --no-cache libstdc++ tini \
 && addgroup -g 1000 -S trustwork && adduser -u 1000 -S -G trustwork -H -h /app trustwork
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
ENV NODE_ENV=production
ENTRYPOINT ["/sbin/tini", "--"]

# ---------- api ----------
FROM runtime AS api
COPY --from=deps /out/api/node_modules ./node_modules
COPY --from=build /src/.image-build/apps/api ./apps/api
COPY --from=build /src/.image-build/packages/contracts ./packages/contracts
COPY --from=build /src/.image-build/packages/data ./packages/data
# The readiness probe compares the database ledger with the migrations this build ships.
COPY packages/data/migrations ./packages/data/migrations
COPY --from=build /src/infra/images/runtime-layout.mjs /tmp/layout/
COPY --from=build /src/apps/api/package.json /tmp/layout/apps/api/package.json
COPY --from=build /src/packages/contracts/package.json /tmp/layout/packages/contracts/package.json
COPY --from=build /src/packages/data/package.json /tmp/layout/packages/data/package.json
RUN node /tmp/layout/runtime-layout.mjs /tmp/layout /app apps/api packages/contracts packages/data && rm -rf /tmp/layout
USER 1000:1000
ENV API_HOST=:: API_PORT=3001
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/api/src/main.js"]

# ---------- worker ----------
FROM runtime AS worker
COPY --from=deps /out/worker/node_modules ./node_modules
COPY --from=build /src/.image-build/apps/worker ./apps/worker
COPY --from=build /src/.image-build/packages/contracts ./packages/contracts
COPY --from=build /src/.image-build/packages/data ./packages/data
COPY --from=build /src/infra/images/runtime-layout.mjs /tmp/layout/
COPY --from=build /src/apps/worker/package.json /tmp/layout/apps/worker/package.json
COPY --from=build /src/packages/contracts/package.json /tmp/layout/packages/contracts/package.json
COPY --from=build /src/packages/data/package.json /tmp/layout/packages/data/package.json
RUN node /tmp/layout/runtime-layout.mjs /tmp/layout /app apps/worker packages/contracts packages/data && rm -rf /tmp/layout
USER 1000:1000
# /metrics and /health/live stay on loopback inside the container; the health check reads them there.
ENV WORKER_METRICS_HOST=127.0.0.1 WORKER_METRICS_PORT=9464
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --start-interval=2s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WORKER_METRICS_PORT||9464)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Reconciliation of parked jobs: docker run ... trustwork-worker node apps/worker/src/cli.js parked
CMD ["node", "apps/worker/src/main.js"]

# ---------- migrate: one-shot release job (migrations, then kernel reference data) ----------
FROM runtime AS migrate
COPY --from=deps /out/migrate/node_modules ./node_modules
COPY --from=build /src/.image-build/packages/contracts ./packages/contracts
COPY --from=build /src/.image-build/packages/data ./packages/data
COPY --from=build /src/.image-build/packages/country-packs ./packages/country-packs
COPY packages/data/migrations ./packages/data/migrations
COPY data/taxonomy ./data/taxonomy
COPY infra/images/migrate-job.mjs ./bin/migrate-job.mjs
COPY --from=build /src/infra/images/runtime-layout.mjs /tmp/layout/
COPY --from=build /src/packages/contracts/package.json /tmp/layout/packages/contracts/package.json
COPY --from=build /src/packages/data/package.json /tmp/layout/packages/data/package.json
COPY --from=build /src/packages/country-packs/package.json /tmp/layout/packages/country-packs/package.json
RUN node /tmp/layout/runtime-layout.mjs /tmp/layout /app packages/contracts packages/data packages/country-packs \
 && printf '{"type":"module","private":true}\n' > /app/package.json \
 && rm -rf /tmp/layout /app/data/taxonomy/README.md
USER 1000:1000
# A one-shot job has no health check; it exits 0 when the database is migrated and the kernel data is in sync.
HEALTHCHECK NONE
CMD ["node", "bin/migrate-job.mjs", "release"]

# ---------- default image when no --target is given ----------
FROM ${TRUSTWORK_IMAGE} AS selected
