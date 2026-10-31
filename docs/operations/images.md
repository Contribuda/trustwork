# Container images and the local stack

Status: **Live** for local use and CI (OPS-002). Nothing is deployed by this repository; the Railway section below is documentation only. The [operations runbook](runbook.md) holds the release gate these images feed into.

## The images

| Image | Built from | Contents | Command | Port | Health check |
|---|---|---|---|---|---|
| web | [`infra/Dockerfile`](../../infra/Dockerfile) | Next standalone output of `apps/web`, its static files, public files, locale files and repository artworks | `node apps/web/server.js` (listens on `::`, IPv4 and IPv6) | `PORT`, default 3000 | `GET <base path>/icon.svg` |
| api | [`infra/images/backend.Dockerfile`](../../infra/images/backend.Dockerfile), target `api` | compiled `apps/api`, `packages/contracts`, `packages/data`, the SQL migrations (readiness compares the ledger with them), production dependencies of those workspaces | `node apps/api/src/main.js` | `API_PORT`, default 3001 on `::` | `GET /health/live` |
| worker | same file, target `worker` | compiled `apps/worker`, `packages/contracts`, `packages/data` | `node apps/worker/src/main.js` | none public; `/metrics` and `/health/live` on 127.0.0.1:9464 inside the container | `GET /health/live` on the metrics port |
| migrate | same file, target `migrate` | compiled `packages/data`, `packages/contracts`, `packages/country-packs`, the migrations, `data/taxonomy`, [`migrate-job.mjs`](../../infra/images/migrate-job.mjs) | `node bin/migrate-job.mjs release` (one-shot) | none | none (exit code) |
| proxy | [`infra/proxy/Dockerfile`](../../infra/proxy/Dockerfile) | Caddy 2.11 with [`infra/proxy/Caddyfile`](../../infra/proxy/Caddyfile) | `caddy run` | `TRUSTWORK_PROXY_PORT`, default 8080 | `GET /proxy/health` |

Shared properties, enforced in CI by [`check-images.mjs`](../../infra/images/check-images.mjs):

- **Non-root.** Every image sets `USER 1000:1000` (numeric, so `runAsNonRoot` checks work) and the check starts each image and requires a non-zero uid. Application files are owned by root and read-only for the process; the compose stack also runs the containers with a read-only root filesystem, all capabilities dropped (the proxy keeps the Caddy binary's own bind capability) and `no-new-privileges`.
- **Nothing for development.** Multi-stage builds: the build stages compile and install, the final stage copies only compiled JavaScript and production dependencies. The check fails when any devDependency of the root or of a workspace (that is not also a production dependency somewhere) is present, when `/app` contains tests, `*.test.*`/`*.spec.*` files, Markdown, TypeScript sources or a package manager (`npm`, `npx`, `yarn`, `corepack`). Node images are the Node binary on plain Alpine 3.24 with `libstdc++` and `tini` (PID 1, forwards SIGTERM so the worker drains and the API closes cleanly); there is no npm or yarn in them. One exception is intentional: the migrate image carries a one-line `packages/country-packs/src/index.ts` that re-exports the compiled `index.js`, because the kernel sync loads the country packs by a source-relative URL with a `.ts` extension (`packages/data/src/repositories/kernel.ts`); Node's built-in type stripping loads it.
- **No configuration inside.** No image contains a connection string, key, origin or `.env` file; everything is a runtime variable (below). The only build-time values are the web app's `NEXT_PUBLIC_*` variables and `TRUSTWORK_ALLOWED_ORIGINS`, which Next freezes into the standalone build.
- **Size budgets.** [`budgets.json`](../../infra/images/budgets.json) caps the root filesystem of each image (`du -skx /` inside the container, the same on every image store). Measured values are in "Measured sizes" below.

### How the backend images run compiled code

The workspaces export TypeScript sources (`"exports": "./src/index.ts"`) and the repository runs them through `tsx`, a devDependency. The images do not: [`tsconfig.backend.json`](../../infra/images/tsconfig.backend.json) compiles the API, the worker and the packages they load into one tree that mirrors the repository layout (so `packages/data/migrations`, `data/taxonomy` and the country packs resolve at the same relative paths), and [`runtime-layout.mjs`](../../infra/images/runtime-layout.mjs) writes runtime `package.json` files whose `exports` point at the compiled `.js` files and links `node_modules/@trustwork/*` to them. [`prune-modules.sh`](../../infra/images/prune-modules.sh) removes READMEs, changelogs, type declarations, source maps and test folders from the production `node_modules` (licence and notice files stay).

### The web image and the hosted preview

`infra/Dockerfile` stays the web image and keeps the interface the hosted preview relies on: the same path, the same build arguments (`NEXT_PUBLIC_BASE_PATH`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_TRUSTWORK_BRAND`), the same `PORT` variable and the same dual-stack listen address (`::`). What changed:

- The final stage is the Next standalone server (`node apps/web/server.js`) instead of `next start` over the whole build tree, runs as uid 1000 and has a health check.
- Standalone output is switched on with Next's `NEXT_PRIVATE_STANDALONE=1` during the build, so `apps/web/next.config.ts` is unchanged; the build fails if `server.js` is missing after a Next upgrade. Follow-up: an explicit, opt-in `output` setting in `next.config.ts` (owned by the web app) would remove the reliance on a private variable.
- The standalone server reads `next.config.ts` at build time, not at start. **`TRUSTWORK_ALLOWED_ORIGINS` is therefore a build argument now**; Railway passes a service variable to the build when a Dockerfile declares an `ARG` of the same name, so a preview that already sets it as a service variable keeps working. Setting it only at runtime has no effect any more.
- The preview build arguments are rebuilt and started in CI (base path `/trustwork`, health check through the base path) so a change that breaks the preview fails the pull request.

## Runtime configuration

Values are read from the environment only; nothing loads `.env` implicitly. Secrets come from the host's secret store, never from the image, the compose file (local-only defaults excepted) or Git.

| Image | Required | Common optional | Notes |
|---|---|---|---|
| api | `API_DATABASE_URL` (a login that is a member of `trustwork_app` only), and with the image default `NODE_ENV=production`: `AUTH_FLOW_SECRET` (hex, 32+ bytes), `PUBLIC_ORIGIN` (`https://...`, the one public origin) | `API_TRUSTED_PROXY_HOPS` or `API_TRUSTED_PROXIES`, `AUTH_PROVIDER_MODE` and provider client credentials, `API_LOG_LEVEL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `TRUSTWORK_HSTS` | Full list: [`.env.example`](../../.env.example) and `apps/api/src/config.ts`. An invalid configuration prints one `config.invalid` line naming variables (never values) and exits 78 |
| worker | `WORKER_DATABASE_URL` (a login that is a member of `trustwork_worker` only) | `WORKER_CONCURRENCY`, `WORKER_LEASE_SECONDS`, `WORKER_SHUTDOWN_GRACE_MS` (keep it below the host's stop timeout) | [`apps/worker/README.md`](../../apps/worker/README.md). Parked jobs: `node apps/worker/src/cli.js parked` in the worker container |
| migrate | `DATABASE_URL` (or `TRUSTWORK_DATABASE_*`) of the migrator | `TRUSTWORK_MIGRATIONS_DIR` (tests only) | Commands: `release` (default: `up`, then the kernel sync), `up`, `status`, `verify`, `kernel-sync [--dry-run]`. Exit 0 ok, 1 failure, 2 usage or configuration, 3 refused role |
| web | none | `PORT`, `TRUSTWORK_DEFAULT_COUNTRY` (the reference hub uses `US`), `TRUSTWORK_DEMO_PERSONA`, `TRUSTWORK_HSTS`, `TRUSTWORK_LISTEN_HOST` (default `::`) | Build arguments: `NEXT_PUBLIC_BASE_PATH`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_TRUSTWORK_BRAND`, `TRUSTWORK_ALLOWED_ORIGINS` |
| proxy | none | `TRUSTWORK_API_UPSTREAM` (default `api:3001`), `TRUSTWORK_WEB_UPSTREAM` (default `web:3000`), `TRUSTWORK_PROXY_PORT`, `TRUSTWORK_PROXY_TRUSTED_RANGES` | See the Caddyfile header |

### Database roles

The migrate job runs as the **migrator**, never as a runtime role: it refuses (exit 3) a login that is a member of `trustwork_app` or `trustwork_worker` unless it is a superuser, and the migration runner itself requires a superuser or a member of `trustwork_owner` with `SET`. The migrator needs, created once by operations with a superuser (roles are cluster-wide):

- the NOLOGIN groups `trustwork_owner`, `trustwork_app`, `trustwork_worker` with the attributes of the runner's bootstrap (it skips groups that exist) and `GRANT SET ON PARAMETER trustwork.maintenance TO trustwork_owner` (only a superuser can grant it);
- `CREATE ROLE <migrator> LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE INHERIT` and `GRANT trustwork_owner TO <migrator> WITH SET TRUE, INHERIT TRUE`, plus `CREATE` on the database. **`INHERIT` is required**: the runner reads the ledger in the owner's schema before it switches role, and a `NOINHERIT` migrator fails with "permission denied for schema trustwork" (found while building this stack; the data README only mentioned `SET`);
- one login per runtime process: `... LOGIN INHERIT IN ROLE trustwork_app` for the API and `... LOGIN INHERIT IN ROLE trustwork_worker` for the worker.

[`infra/images/stack-roles.sql`](../../infra/images/stack-roles.sql) is exactly this step for the local stack (with `trustwork_stack_*` names so it never touches development or test roles on a shared cluster).

## The local stack

```sh
docker compose -f infra/compose.yaml --profile stack up --build -d
node infra/images/stack-smoke.mjs        # optional: the same checks CI runs
open http://localhost:8080               # TRUSTWORK_STACK_PORT changes the port
docker compose -f infra/compose.yaml --profile stack down        # keeps the volumes; add -v to drop them
```

`npm run infra:up` is unchanged and still starts PostgreSQL alone; every other service is in the `stack` profile. Start order (compose `depends_on` conditions): `postgres` (healthy) then `db-roles` (the operations step above, as the local superuser; exits 0) then `migrate` (migrations and the kernel reference data as `trustwork_stack_migrator`, in database `trustwork_stack`; exits 0) then `api` (healthy means **ready**: database reachable and ledger equal to the migrations in the image) and `worker` (healthy), then `web` (healthy) and finally `proxy`, the only published port, bound to 127.0.0.1. `storage` is an S3-compatible object store (SeaweedFS 4.48, Apache-2.0) on the compose network only, without credentials and not published; no code uses object storage yet, the storage adapter arrives with its package.

One origin: the proxy routes `/v1` and `/v1/*` to the API and everything else to the web app, so the browser sees one origin, the session cookie is `__Host-` scoped to it, and the API's CSRF check compares `Origin` with `PUBLIC_ORIGIN` (`http://localhost:8080`). Local-only differences from production, all set in `compose.yaml` and refused by the API with `NODE_ENV=production`: `NODE_ENV=development`, a plain-http localhost origin, and `AUTH_PROVIDER_MODE=fake` with `API_LOG_MAIL=1`, which prints verification tokens to the API log because no mail provider is configured. The web app still uses its own demo sign-in until WEB-004 wires it to `/v1`; the API flows below are what this stack proves.

[`stack-smoke.mjs`](../../infra/images/stack-smoke.mjs) checks, through the proxy only: the web home page (`lang="en"`, title Trustwork, no `Server` header); `/v1/me` answered by the API (401 `auth.session_invalid`); CSRF rejects a mutation without `X-Trustwork-Request` and a cross-site one; sign-up (202, no session), no login before verification, the token from the fake mailbox, e-mail verification, login with a `__Host-` `Secure` `HttpOnly` cookie without `Domain`, `/v1/me` with the session, logout and 401 afterwards; every service healthy and the migrate job exited 0; every application container at uid 1000; the migrate image refusing the API's runtime login (exit 3); the API image refusing `NODE_ENV=production` with an http origin and no flow secret (exit 78) without printing values. Environment: `TRUSTWORK_STACK_ORIGIN` and `TRUSTWORK_STACK_COMPOSE` (for example `docker compose -p my-stack -f infra/compose.yaml --profile stack` to run a second copy next to a shared development database; set `TRUSTWORK_PG_PORT` and `TRUSTWORK_STACK_PORT` to free ports).

## CI

[`.github/workflows/images.yml`](../../.github/workflows/images.yml) runs on pull requests and pushes to `main` that touch `apps/`, `packages/`, `data/`, `infra/`, the root manifests, `.dockerignore` or the workflow: it builds all five images with `docker compose build` (nothing is pushed to any registry), runs the image policy and size budgets, rebuilds the web image with the preview's build arguments and checks it becomes healthy under its base path, writes an SPDX JSON SBOM per image with Syft (pinned by digest, run as a container against the local images) and uploads them as the `sbom` artifact, then starts the whole stack and runs the stack smoke. Logs are printed on failure and the stack is removed with its volumes at the end.

## Measured sizes

Root filesystem (`du -skx /`) of the local linux/arm64 build on 2026-10-31; the budgets leave room for the amd64 runner and normal dependency growth.

| Image | Measured | Budget | Of which the base (Alpine, Node binary, libstdc++, tini) |
|---|---|---|---|
| web | 202.1 MiB | 280 MiB | about 130 MiB |
| api | 154.3 MiB | 200 MiB | about 130 MiB |
| worker | 138.3 MiB | 180 MiB | about 130 MiB |
| migrate | 139.3 MiB | 180 MiB | about 130 MiB |
| proxy | 58.8 MiB | 80 MiB | Caddy's own Alpine image |

## Deploying the same images on Railway (documentation only)

Nothing here has been done; no Railway project, service or variable was created or changed by OPS-002. The US reference hub is decided to run on Railway (ADR 012, decision 26); deploying it needs the owner's explicit authorization and is a separate step of the [release gate](runbook.md#release-gate).

Services, each built by Railway from this repository:

| Service | Dockerfile (`RAILWAY_DOCKERFILE_PATH`) | Image selection | Public domain | Railway health check path |
|---|---|---|---|---|
| proxy | `infra/proxy/Dockerfile` | n/a | **yes, the only one** | `/proxy/health` |
| web | `infra/Dockerfile` (the existing preview path) | n/a | no | `/icon.svg` (with a base path: `<base>/icon.svg`) |
| api | `infra/images/backend.Dockerfile` | service variable `TRUSTWORK_IMAGE=api` | no | `/health/ready` |
| worker | `infra/images/backend.Dockerfile` | `TRUSTWORK_IMAGE=worker` | no | none (no public port) |
| migrate | `infra/images/backend.Dockerfile` | `TRUSTWORK_IMAGE=migrate`, restart policy "never" | no | none |
| PostgreSQL | Railway's PostgreSQL service | n/a | no | n/a |

- **Image selection without build targets.** The backend Dockerfile's last stage is `FROM ${TRUSTWORK_IMAGE}`; Railway passes a service variable to the build when the Dockerfile declares a matching `ARG`, so one file yields the three images. Locally and in CI the same images are built with `--target`.
- **The preview keeps working.** The existing preview service keeps `RAILWAY_DOCKERFILE_PATH=infra/Dockerfile`. Its next build uses the standalone image; `TRUSTWORK_ALLOWED_ORIGINS` must be a service variable (it is read at build time now). Watch the first deployment's health and roll back to the previous deployment in Railway if the page does not answer.
- **Routing.** Railway terminates TLS at its edge and forwards to the proxy, which reaches the other services over the private network: `TRUSTWORK_API_UPSTREAM=api.railway.internal:3001`, `TRUSTWORK_WEB_UPSTREAM=web.railway.internal:3000`, `TRUSTWORK_PROXY_PORT=$PORT` (or set the service port to 8080). The private network is IPv6; the API (`API_HOST=::`) and web (`::`) images already listen on it. The base path is empty for a hub that owns its domain; the proxy design assumes the app owns the whole origin (`/v1` is at the root).
- **Client addresses.** With the edge in front of the proxy, keep the edge's `X-Forwarded-For` by setting `TRUSTWORK_PROXY_TRUSTED_RANGES` to the range the edge connects from (verify the peer address in the proxy's JSON access log; `private_ranges` is Caddy's shorthand for private networks) and set `API_TRUSTED_PROXY_HOPS=2` on the API. Never trust every hop.
- **Variables.** api: `API_DATABASE_URL` (runtime login), `AUTH_FLOW_SECRET`, `PUBLIC_ORIGIN=https://<domain>`, provider settings, optionally `TRUSTWORK_HSTS` once the hub owns the domain. worker: `WORKER_DATABASE_URL`. migrate: `DATABASE_URL` of the migrator **only on the migrate service**. web: the build arguments plus `TRUSTWORK_DEFAULT_COUNTRY=US`. Use Railway's sealed variables for secrets; never put them in the repository.
- **Roles.** Run the role step from "Database roles" once with the PostgreSQL superuser (for example through `railway connect` and `psql`), with production names such as `trustwork_migrator`, `trustwork_api_login`, `trustwork_worker_login` and generated passwords.
- **Release order.** Deploy migrate first and wait for exit 0, then the API, worker and web, then the proxy if it changed. A pre-deploy command on the API service is deliberately not used: it would put the migrator's credentials into the API service's environment. Because the API's Railway health check is `/health/ready`, an API whose image expects migrations the database does not have yet stays not ready and does not receive traffic. Migrations are expand/migrate/contract, so the previous API keeps working against the migrated schema.
- **Object storage.** The compose stack's SeaweedFS stands in for a Railway bucket (S3-compatible); wiring belongs to the storage adapter package.

## Limitations and follow-ups

- The web app does not call `/v1` yet (WEB-004); the stack proves sign-up and login through the proxy against the API, not through the web pages.
- Verification mail is read from the fake mailbox log; a mail-catcher service belongs with the SMTP adapter (MAIL-001).
- `NEXT_PRIVATE_STANDALONE` is a private Next variable (see above); `.dockerignore` (root configuration, not owned by OPS-002) does not exclude `apps/web/.next-*` browser-test builds, so a local build context can be larger than needed.
- `packages/data/bin/migrate.mjs` and `kernel-sync.mjs` load TypeScript through `tsx`; `migrate-job.mjs` repeats their few lines over the compiled tree. A compiled entry in `packages/data` would remove the duplication.
- Images are built for the runner's platform only (linux/amd64 in CI); multi-platform builds and registry publication come with a deployment decision.
