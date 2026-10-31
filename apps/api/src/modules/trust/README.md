# Trust module: reviews, appeals and reputation snapshots (EXE-001)

Rules and the method `engine-evidence-0.1`: [reputation policy](../../../../../docs/product/reputation-policy/README.md). Method code: [`method.ts`](method.ts). Contracts: [`contracts.ts`](contracts.ts). The `review-integrity` subdirectory belongs to REV-001.

| Route | Who | Result |
|---|---|---|
| `GET /v1/trust/agreements/:id/reviews` | The two parties | Reviews with corrections, responses and appeal status |
| `POST /v1/trust/agreements/:id/reviews` | A person acting for one party of a completed agreement; no actor field | Once per side (`409` otherwise); `correctsReviewId` appends a correction |
| `POST /v1/trust/reviews/:id/response` | The reviewed party, once | A public answer; never removes the review |
| `POST /v1/trust/appeals` | The reviewed or observed party | Files into DATA-002's `appeal` queue of the hub (`TRUSTWORK_HUB_ID`); decided by `admin_decide_appeal`, never by the original decider |
| `POST /v1/reputation/snapshots` | A person acting for the subject (self, or the company with `company.deals.manage`) | Computes and stores a snapshot from the evidence the subject reads as a party; returns the summary and its explanation |
| `GET /v1/reputation/:kind/:id/own` | The subject | The latest own snapshot with the explanation |
| `GET /v1/reputation/:kind/:id` | Anyone | The masked public summary (`people` or `companies`): counts only, "not enough data" below the minimum sample, `publicScore: null` |

Nothing here reads a billing table; paying the platform cannot change a snapshot (`tests/trust/api.test.ts`).
