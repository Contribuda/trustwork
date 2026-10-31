# Sanctions controls on our own services

Status: **Contract** for the shared admission check (code and tests in `packages/compliance/src/admission`, called by no running service yet); **Designed** for every service control below. No service named in this runbook enforces anything today unless its row says Live. Work package SANC-008; decisions in [ADR 014](../adr/014-sanctions-compliance-engine.md) (decisions 3 to 5) and [ADR 011](../adr/011-federation-mesh.md) (decision 12); the engine-side design is the handbook chapter [Sanctions compliance](../engine/modules/sanctions-compliance.md). Not legal advice: every point that depends on law is listed under [open questions](#open-questions-owner-and-counsel) for counsel.

## The line: the engine does not police itself

The owner decided on 2026-10-31 (ADR 014 decision 3) that Trustwork ships **no code that geolocates the server it runs on, phones home, or disables itself by location**. Such a switch is removed in a fork with one commit, is unreliable, and would erode the trust an open engine depends on.

What this means in practice:

- The engine never asks any outside service where it is, never reports its own address or location anywhere, and contains no update check, licence check or telemetry call to the project that could carry it (OpenTelemetry export goes only to an endpoint the operator configures, `OTEL_EXPORTER_OTLP_ENDPOINT`).
- The visitor gate of SANC-001 is not an exception: it runs inside an operator's own deployment, under that operator's configuration, with a local dataset, and judges **visitors**, never the server; no address or decision leaves the server.
- The admission check described here runs on **our** side of a connection, inside a service the project's operator (Contribuda) runs, and judges the **other** party. An operator who never connects to our services is not affected by it; an operator may also call it for their own receiving services.

Enforcement therefore happens on what we control: our federation and mesh admission, our release channel and registry, our public hub directory, our support channels and the services Contribuda hosts. Forks running in restricted places may also not use the Trustwork name or mark (`NOTICE` and [BRAND.md](../oss/BRAND.md); the explicit wording is for counsel, open question 2).

## The shared admission check

`checkAdmission(request, context)` in `packages/compliance/src/admission/index.ts` is a pure, synchronous function: it reads only its arguments, keeps no state between calls and makes no network call. Every service below calls it; none reimplements it.

| Input | What it carries |
|---|---|
| `service` | One of `federation_handshake`, `hub_directory`, `release_channel`, `registry_pull`, `support`, `hosted_service`. The service fixes the policy; a caller never passes a policy. |
| `subject` | A label for review: a node name, a support case reference, or nothing for an anonymous download. A label that is a network address refuses the request and is not recorded. |
| `manifest`, `declaredPlaces` | **Declared** evidence: the other node's manifest (jurisdiction, operator country, hub territories; see [federation](../engine/federation.md#node-identity)) or places it stated about itself. |
| `attestation` | **Attested** evidence: the other node's deployment-location attestation (operator entity and hosting country and region, SANC-009). An operator statement, never a verification. |
| `observed` | **Observed** evidence: the connection as our door sees it (the client address after our trusted-proxy rules, and header access), resolved to a place by our geolocation port. |
| `context` | The authoritative restricted list (`restricted.json` or its kernel mirror), our geolocation port (`ranges_file`, `edge_header`, `upstream_gate`; `fake` only in tests) and the time. |

Rules the check applies:

1. Every piece of evidence that is presented is judged. One piece that places the party in a restricted place refuses, whatever the others say.
2. Evidence the service requires and the caller did not present refuses (`evidence_missing`). Evidence that cannot be read refuses (`evidence_invalid`); it is never skipped.
3. Region granularity follows the list: a territory, attestation or address in `UA-43`, `UA-40`, `UA-14` or `UA-09` refuses; another Ukrainian region is served. An attested location in a country restricted only by region (Ukraine) without its region refuses (`region_required`), as the SANC-009 attestation itself does.
4. An expired attestation refuses (`attestation_expired`). A service that requires an observed place refuses while our geolocation port is unconfigured (`geolocation_unconfigured`).
5. There is no allowlist, override, staff bypass, header, mandate or setting that admits a party one piece of evidence places in a restricted place; the owner and the operators included. The policy table is frozen in code.

`admitPeerAtHandshake({ manifest, attestation, observed }, context)` is the call FED-001 makes at handshake (below). `admissionLogEvent(decision)` builds the log event of a refusal.

### Which evidence each service requires

| Service | `service` value | Declared | Attested | Observed |
|---|---|---|---|---|
| Federation and mesh admission | `federation_handshake` | required | required | required |
| Public hub directory listing | `hub_directory` | required | required | required |
| Official update and release channel | `release_channel` | judged if given | judged if given | required |
| Container registry pulls | `registry_pull` | judged if given | judged if given | required |
| Support channels | `support` | judged if given (a stated country) | judged if given | required |
| Services Contribuda hosts | `hosted_service` | judged if given | judged if given | required |

## Controls per service

| Service | Status today | Control | Where it runs | On refusal |
|---|---|---|---|---|
| Federation and mesh admission | **Designed** (FED-001 not built; no node federates) | `admitPeerAtHandshake` after the peer manifest's signature is verified and before any peering record is written; again whenever the peer's manifest or attestation changes, when the attestation expires, and on every later request admitted from that peer | The receiving node's federation endpoint | HTTP 451 with `federation.peer_restricted`; no peering record; the refusal record is stored |
| Public hub directory | **Designed** (no directory runs) | `checkAdmission` with `hub_directory` when a node asks to be listed and at every refresh of its listing; a listed node whose evidence turns restricted is removed at the next refresh | The directory service Contribuda would run | The node is not listed or is delisted; the refusal record is stored |
| Official update and release channel | **Designed** (source is published on GitHub; no release downloads or update service of our own exist; the engine has no update check) | Where we front downloads (a release mirror or download page), `checkAdmission` with `release_channel` on each download request through our geolocation port; nothing in the engine calls the channel | Our download front | HTTP 451; the release is not served |
| Container registry pulls | **Designed** (no image is pushed to any registry, see [container images](images.md)) | Where we front a registry, `checkAdmission` with `registry_pull` on token issue and on each pull; where the registry is a third party's, that provider's own access policy applies and we add no claim beyond it | Our registry front or token service | HTTP 451 on the token or the pull |
| Support channels | **Designed** (today: GitHub issues and private vulnerability reports per `SECURITY.md`) | `checkAdmission` with `support` on forms and mailboxes we run; a stated country is judged when given; on third-party platforms the maintainers follow `NOTICE` and the platform's own policy | Our support form or mailbox intake | The request is not taken; the person sees the refusal words and the contact for a wrong place |
| Services Contribuda hosts | **Live** in part: the hosted preview sits behind a hosting landing whose place check refuses restricted places (`upstream_gate`); **Designed** for the public reference hub (the SANC-001 visitor gate at every door) | The SANC-001 jurisdiction gate at every door, plus `checkAdmission` with `hosted_service` where such a service admits an operator or a node (for example a hosted hub's operator onboarding) | The hosted service | The SANC-001 refusal page or `jurisdiction.restricted` (451); the refusal record where the admission check ran |

Every control above is a planned control until its row says Live; do not describe a Designed control as enforced.

## Refusals: what is recorded, logged and kept

- **Record** (`AdmissionRefusalRecordSchema`, strict): the service, the subject label (a node name or case reference, never an address), the decision time, the findings (reason, evidence kind, source, place, dataset) and the geolocation mode and dataset that answered. Declared evidence names the dataset `declared`, attested evidence `attestation`, observed evidence the geolocation dataset (for example `dbip-city-lite-2026-10` or `edge-header`). A record with any other field does not parse.
- **Log event** (`admission.refused`): service, reasons, places, sources, datasets and time. No subject, no address, no header, no manifest body. It feeds the cohort metrics of ADR 014 decision 18 (refusals per service, place and day).
- **Never** written anywhere: the client address, request headers, the raw manifest beyond what the record names, or any per-person refusal log beyond the record.
- **Kept** for the sanctions record-keeping period of the operating entity's country pack (United States: ten years, ADR 014 decision 17); records are append-only.

## Who reviews refusals

- A **compliance reviewer** designated by the owner for our services reviews refusal records weekly and on every request from a refused party. Who holds the role, and the service level, are open (ADR 014 open question 4).
- The reviewer cannot admit a party the check refuses: there is no override. A refusal ends only when the evidence changes: the peer corrects its manifest or renews its attestation, or our geolocation dataset is corrected (a dataset error is fixed by refreshing or replacing the dataset through a reviewed change, never by an exception for one party).
- A refused party may write to the contact on the refusal; the reviewer answers what the law allows and records the outcome beside the refusal record. A suspected sanctioned operator entity goes to list screening (SANC-003) and its review queue, not to this runbook.
- Changes to the restricted list itself are a reviewed pull request with an ADR (ADR 014 decision 2); this runbook never changes it.

## Review checklist

Every pull request that touches sanctions, federation, the update or release channel, the registry, the hub directory, support intake, operations or start-up code is reviewed against these items, and the pull request description repeats the first one:

- [ ] **No code geolocates its own server, phones home or disables itself by location** (ADR 014 decision 3). Location checks judge the other party, on our side of the connection. (Tripwire: `tests/compliance/admission/no-self-geolocation.test.ts`.)
- [ ] No network address in a record, log line, metric label, outbox payload or error message; records name the place and the dataset.
- [ ] Restricted places come only from `packages/country-packs/packs/restricted.json` (or its kernel mirror); no new list, allowlist, override or setting.
- [ ] New service controls call `checkAdmission` (or `admitPeerAtHandshake`) instead of reimplementing it, and keep their status label honest here.

## Limits

The check acts on what it knows and claims no more (ADR 014 decision 5): a VPN defeats an address check, an operator can state a false attestation, and a manifest is what its node declares. The records keep the evidence; list screening of operator entities (SANC-003, ADR 011 decision 12) and later signals beside the address (known hosting and VPN ranges) are separate controls.

## Open questions (owner and counsel)

1. Whether refusing on our federation, directory, release, registry and support services as described is sufficient for the project's operator, and whether anonymous source downloads through third-party platforms need any further step.
2. The wording of the brand policy for forks in restricted places and the export-control wording that accompanies publication of the source (ADR 014 open question 6).
3. Who holds the compliance-reviewer role for our services and the service level for answering a refused party (ADR 014 open question 4).
4. The geolocation adapter for our services once they exist (ranges file, edge header or both; ADR 014 open question 2).
5. What a refused party may be told, and the record-keeping period for refusal records outside the United States.
