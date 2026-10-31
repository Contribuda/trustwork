# Execution module: claims, evidence, decisions, defects and disputes (EXE-001)

Rules, fair timing and the method: [reputation policy](../../../../../docs/product/reputation-policy/README.md). Storage: [`packages/data/migrations/execution`](../../../../../packages/data/migrations/execution). Contracts: [`contracts.ts`](contracts.ts) (to be promoted into `packages/contracts/src/execution.ts` by the integrator).

All mutations: authenticated session, `X-Trustwork-Request` with same-origin metadata, `Idempotency-Key`; every route completes its idempotency record inside its own request transaction (BE-005). Errors use the contract envelope; specific reasons are in `details.reason`. Everyone but the two parties of the agreement gets `404`.

| Route | Who | Result |
|---|---|---|
| `GET /v1/execution/agreements/:id` | The two parties | `ExecutionView`: obligations with progress, claims with state, evidence and decision, defects, disputes with outcome, observations, timing facts, completion |
| `POST /v1/execution/agreements/:id/claims` | The obligor (person, or company member with `company.deals.manage`); its agent under `record_evidence` | Goods delivery, work or service performed, payment made, or remediation of a defect; `supersedesClaimId` appends a correction of the claimant's open claim |
| `POST /v1/execution/agreements/:id/evidence` | The claimant (or the defect's reporter); its agent under `record_evidence` | Links a FILE-001 artifact of the agreement with its digest |
| `POST /v1/execution/claims/:id/decision` | A person acting for the counterparty; no actor field | Accepted, partially accepted or rejected; observations are materialized in the same transaction |
| `POST /v1/execution/agreements/:id/defects` | Either party about the other; its agent under `record_evidence` | Severity, location, description; closed by an accepted remediation claim |
| `POST /v1/execution/agreements/:id/disputes` | The party a confirmation or defect went against; no actor field | Needs `TRUSTWORK_HUB_ID` (the hub whose trust reviewers decide) |
| `POST /v1/execution/disputes/:id/appeal` | Either party, once, after the decision | Decided by a different reviewer |

Staff decisions are the owner-run commands `execution_decide_dispute` and `execution_decide_dispute_appeal` (DATA-002 elevation, permission, conflict check and audit), reachable through `executionDisputes.decide` and `decideAppeal`; their console routes are a later slice. Mandates: `ExecutionMandatePort`, default `NoExecutionMandates` (every agent request refused until the mandate store exists). Registry entries: `EXECUTION_EVIDENCE_MANIFEST` (module `execution_evidence`).
