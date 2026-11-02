# Source collection (SRC-002)

The pre-collection gate on the worker. Contract and pure decision: [`packages/contracts/src/collection-policy.ts`](../../../../packages/contracts/src/collection-policy.ts). Design: [the editorial office](../../../../docs/engine/editorial-office.md) and [ADR 026](../../../../docs/adr/026-discovery-to-claim-engine-and-professional-pages.md) decision 1.

- **`collector.ts`**: decides before any request leaves the node.
  - Registry and law deny with no network at all.
  - robots.txt and `/.well-known/tdmrep.json` are cached for at most 24 hours; a 5xx or failed robots.txt disallows, a 4xx allows (RFC 9309).
  - The host's polite slot comes next: one request in flight, crawl delay, backoff on 429 and 503 honouring Retry-After.
  - The target is requested only when allowed. Its headers (TDMRep, Content-Usage) and access barriers decide again; content behind a login, paywall or challenge is dropped.
- **`fetch-step.ts`**: the pipeline `fetch` step (PIPE-001).
  - Every source of the run's version goes through the collector, and allowed content is carried to the next step with the uses it may serve.
  - A changed robots, terms, RSL, TDMRep or Content-Usage digest pauses every pipeline of the source (`pipelines_source_changed`, with an alert) until a person re-checks it in the registry.
  - The worker reads the source through `sources_collection_view` and never writes to the registry.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `COLLECT_CONTACT_URL` | unset | The bot's contact page. The user agent is `TrustworkBot/1 (+<url>)`. Unset means the `fetch` step is not registered, so a collection pipeline fails with `pipelines.step_unavailable` and nothing is fetched. |

## Not yet

- Licence expiry re-checks.
- Publishing the hub's own outbound content terms as an RSL document.
- Restricted-place checks by host location: today the registry refuses restricted places when a source is registered, and the gate takes a predicate.
