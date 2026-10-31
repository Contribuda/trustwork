# ADR 001 — Independent modular monolith

Date: 2026-10-26. Status: selected for foundation; production providers unresolved.

## Context

Public SEO/content/magazine and authenticated procurement workflows need a coherent UI and reusable contracts. Slow assistant/document tasks must not block HTTP. Legacy archive manifests show React/Vite and Nest/TypeORM familiarity, not a mandate or license to copy. A broad product does not justify microservices before measured boundaries.

## Decision

Use npm workspaces, Node 24.18.0, npm 11.16.0, TypeScript 6.0.3, Next.js 16.4.3/React 19.3.1 and NestJS 12.2.0. Exact versions were read from the npm registry, then tested together. Node 24 is the supported LTS line; do not jump to Node 26 merely because latest. TypeScript 7 was available, but the selected typescript-eslint peer range excludes 6.1+, so pin 6.0.3. Separate web/API/worker processes, shared contracts/tokens and product-owned PostgreSQL 18. Local compose uses 18.3, not an unbounded latest tag; production image digest and patch review remain release tasks.

Use reviewed SQL migrations and a typed repository boundary; choose the query library in DATA-001 with measured tradeoffs. No automatic ORM schema sync. Store objects through a neutral port with owner/classification/checksum metadata. Do not add Redis, Kafka, an external vector database, external authorization service or a workflow SaaS at bootstrap. [ADR 007](007-hybrid-retrieval.md) supersedes the earlier lexical-only search deferral: RAG and pgvector are required in the product architecture, with runtime installation deferred to reviewed implementation tasks.

## Alternatives and consequences

Vite SPA is simpler but needs additional public rendering/SEO strategy. Next-only APIs reduce processes but make explicit long-running domain boundaries harder to preserve; Nest is chosen for API modularity and worker reuse, not mandatory framework complexity. Microservices add distributed transactions and operational overhead without demonstrated load. npm is already available and creates a single frozen lockfile without additional package manager bootstrapping. Next production builds use webpack here for a stable explicit build path; evaluate alternative bundlers separately.

Use the official Nest Fastify adapter. The Express adapter included vulnerable Multer 2.4.0 ([advisory](https://github.com/advisories/GHSA-q7qp-rjg7-q26m)); this foundation has no upload middleware requirement. Fastify provides the needed HTTP boundary without that dependency. Future uploads require a separately reviewed Fastify-compatible implementation; Express-specific recipes do not apply. [Official adapter documentation](https://docs.nestjs.com/techniques/performance).

## Evidence

[Node release schedule](https://github.com/nodejs/Release), [Next installation](https://nextjs.org/docs/app/getting-started/installation), [Nest migration guide](https://docs.nestjs.com/migration-guide), [PostgreSQL lifecycle](https://www.postgresql.org/support/versioning/). Registry metadata and exact lockfile are more precise version evidence than search snippets. Revisit on end-of-support, unpatched security exposure, measured scaling need, or incompatible provider constraints.
