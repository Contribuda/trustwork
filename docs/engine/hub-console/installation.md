# Installation

Status: **Proposed** (work package INST-001 in the [console README](README.md#proposed-work-packages)). Today the repository ships a local PostgreSQL compose file (`infra/compose.yaml`) and a web-only container (`infra/Dockerfile`); the installer below does not exist yet. Commands are the design target, not instructions that work today.

The goal: a person who has never seen the code gets a running node and an open setup wizard in about fifteen minutes, on one server, with one command, and nothing insecure left behind.

## What gets installed

| Service | Image | Role | Notes |
|---|---|---|---|
| `postgres` | PostgreSQL 18 (pinned digest) with `pgvector` available | The node's only database | Two roles created on first start: `trustwork_owner` (migrations) and `trustwork_runtime` (no `BYPASSRLS`, FORCE RLS applies) |
| `objects` | An S3-compatible object store (candidates: Garage, SeaweedFS, MinIO; to be chosen in INST-001 for licence and maintenance) | Evidence files, images, PDFs, exports, backups | Bucket per purpose; versioning on; never public; signed URLs with bounded TTL |
| `migrate` | `trustwork` image, one-shot | Applies reviewed forward-only migrations with the checksum ledger, then exits | Runs before `api` and `worker` start; refuses to run on a dirty or unknown schema |
| `api` | `trustwork` image | `/v1/*` API on the same origin | Readiness checks database, schema version and object store |
| `web` | `trustwork` image | Public site, workspace and console | `NEXT_PUBLIC_*` baked at build time for custom images; the published image reads runtime configuration |
| `worker` | `trustwork` image | Jobs, pipelines, provider calls, backups | Leases jobs with `FOR UPDATE SKIP LOCKED`; no provider is live until enabled in the console |
| `proxy` (optional profile `tls`) | Caddy | TLS with automatic certificates, HTTP→HTTPS, security headers | Skip it when a platform terminates TLS |
| `models` (optional profile `local-ai`) | An OpenAI-compatible local model server (Ollama-compatible) | Self-hosted models for private data classes | Never pulls a model without the operator's command; GPU optional |
| `mail` (optional profile `dev`) | A local mail catcher | Development only | Never in production profiles |

## One command

```sh
git clone https://github.com/Contribuda/trustwork.git && cd trustwork
./infra/install/install.sh            # or: docker compose -f infra/install/compose.yaml up -d
```

`install.sh` is a thin, readable script (no `curl | sh`): it checks Docker and Compose versions, free ports, disk space and the clock, asks for the public address (for example `https://build.example.org`), writes `infra/install/.env` with generated secrets (file mode `0600`), and runs `docker compose up -d --wait`. When the stack is healthy it prints:

```text
Trustwork is running.
Open https://build.example.org/admin/setup?token=… within 24 hours to set up this node.
The token works once. Run `./infra/install/install.sh new-setup-token` to issue a new one.
```

### The setup token

A freshly installed node has no administrator, so whoever reaches it first could claim it. The **setup token** closes that gap: 32 random bytes, printed only to the installer's terminal and the `migrate` container log, stored as a SHA-256 hash with an expiry (`SetupStateSchema.setupTokenHash`, `setupTokenExpiresAt`), valid for one setup session, invalid once setup finishes. Without a valid token `/admin/setup` shows a neutral page explaining how to get one from the server. After setup, `/admin/setup` returns not found.

### Generated secrets

| Secret | Purpose | Where it lives |
|---|---|---|
| Database passwords (owner, runtime) | Database roles | `.env`, read by containers; never in the console |
| `TRUSTWORK_KEK` | Key-encryption key for the console's secret store (envelope encryption of provider keys) | `.env` or a mounted file; replace with an external KMS or Vault in production ([providers](providers-and-models.md#secret-storage)) |
| `TRUSTWORK_FINGERPRINT_KEY` | HMAC key for keyed fingerprints of secrets | Same as above |
| Session and CSRF secrets | Web and API | `.env` |
| Object store access keys | Internal service access | `.env` |
| Node signing key (Ed25519) | Federation manifest, signed envelopes, verifiable credentials | Generated in the setup wizard, stored encrypted under the KEK; rotation from the node console |

No default password survives the first start. The installer refuses to start if `.env` contains a placeholder value.

## Configuration that stays outside the console

Only what the node needs to boot lives in environment variables: public URL, database URLs, object store endpoint and credentials, KEK source, log level, `TRUSTWORK_BASE_PATH`. Everything else (hub identity, languages, providers, models, pipelines, prices, policies) is configured in the console and stored as versioned records, so it is audited, two-person where sensitive, and survives redeploys.

## Platform guides

Each guide is a recipe to be written and tested in INST-001; until tested it carries the label "untested".

| Platform | Shape | Notes |
|---|---|---|
| **Single server** (any VPS with Docker) | The compose file above with the `tls` profile | Smallest useful node; backups to an off-host bucket are mandatory before soft launch |
| **Railway** | Services: `web`, `api`, `worker` from the same image with different start commands, a PostgreSQL plugin, a bucket for objects; `migrate` as a pre-deploy command | Railway terminates TLS; set the public URL variable; a one-off command prints the setup token |
| **Fly.io** | Three process groups in one app (`web`, `api`, `worker`), Fly Postgres or an external PostgreSQL, Tigris or another S3-compatible store; `release_command` runs migrations | Choose regions that match the hub's data-residency decision |
| **Kubernetes** | A Helm chart: Deployments for `web`, `api`, `worker`; a `Job` hook for `migrate`; external PostgreSQL (operator such as CloudNativePG) and object storage; `Secret` objects or an external secrets operator | NetworkPolicy restricts egress of `worker` to the providers enabled in the console (the console shows the hostnames to allow) |

Data residency drives the platform choice: a US hub may choose any US region; an EU hub keeps personal data in the EU or records its transfer basis under GDPR; a Samarkand hub that must keep personal data of Uzbek citizens in Uzbekistan needs servers and object storage in Uzbekistan. The setup wizard records the decision; the console warns when a configured storage or provider region contradicts it.

## Sizing (unmeasured)

The numbers below are starting guesses, labelled as such until measured in QA-001; the console's health screen shows real usage.

| Hub stage | CPU | Memory | Disk | Notes |
|---|---|---|---|---|
| Draft, soft launch, small city hub | 2 vCPU | 4 GB | 40 GB | Hosted model providers; no local models |
| Public country hub | 4–8 vCPU | 16 GB | 200 GB + object storage | Separate database server recommended |
| With local models | + GPU or + 8 vCPU | + 16–48 GB | + model files | Only if private data classes must stay on the node |

## Upgrades

```sh
./infra/install/install.sh upgrade        # pull pinned images for the new release, back up, migrate, restart
```

The upgrade path: the node console shows the new release and its notes ([operations](operations.md#updates-and-migrations)); the operator schedules a window; the script takes a backup, verifies it, runs `migrate` (forward-only, expand/migrate/contract), restarts services and checks readiness. If a migration fails, the old application keeps running against the unchanged schema (expand steps are backwards compatible) and the console shows the failure. Production migrations requested from the console need a second person.

## Uninstall and closing a node

`docker compose down` stops services and keeps volumes. Closing a hub is a lifecycle state, not a deletion: participants are notified, can export their data, and federation peers receive tombstones or a handover notice ([Hubs](../hubs.md#hub-lifecycle)). Destroying volumes is a manual, documented step after the retention obligations recorded in the privacy section are met.

## Acceptance (when implemented)

- A clean machine reaches `/admin/setup` with a valid token through one command.
- A second visitor without the token cannot start or resume setup.
- No generated secret appears in logs except the setup token on the installer's terminal and the migrate log.
- The runtime database role cannot bypass row-level security.
- An upgrade with a failing migration leaves the previous version serving.
