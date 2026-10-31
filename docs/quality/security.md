# Security and privacy baseline

Target controls, not certification. Only the bootstrap examples are implemented; do not expose them as a production service. Jurisdiction, hosting region, legal retention and consent policy remain unresolved.

## Threats and required controls

| Threat | Required control | Required evidence before feature release |
|---|---|---|
| Cross-party data leak / guessed IDs | Server object and field authorization on reads/writes/search/export/assets/jobs | Real negative matrix in access-and-journeys; forbidden fields absent, not merely hidden in UI |
| Company departure / stale sessions | Revoke company grants and mandates; versioned cache invalidation | Active sessions, queued actions and signed URLs tested against policy |
| Account takeover | Argon2id password storage with current tuned parameters, rate limit, breached-password policy, secure reset, session rotation | Enumeration/rate-limit/reset/linking tests; no password/OTP primary redesign |
| CSRF/XSS/session theft | Secure HttpOnly SameSite cookie, CSRF/origin checks, output encoding/sanitization, CSP | Browser tests incl. imported rich content and authenticated mutations |
| Malicious uploads / SSRF | Size/type limits, quarantine/scan, isolated parser limits, allowlisted outbound requests, block private IP/redirect bypass | Malformed file, archive bomb, timeout and URL rebinding tests |
| Prompt injection / excess assistant power | Treat documents/email/web/model outputs as data; capability allowlist; structured mandate/digest | Tool redirection, data exfiltration, private-floor and revoke tests |
| Duplicate spend / replay | Durable intent, payload hash, reservations, idempotent receipt, reconciliation | Concurrent budgets and ambiguous provider outcome tests |
| Staff misuse | Separate support/editorial/moderation/commercial roles, time-bound audited case grants | Staff-without-case denied; no unrestricted impersonation |
| Supply-chain compromise | Exact lockfile, reviewed upgrades, `npm audit` recorded with each `local-check`, secret scanning | Local `npm ci`/build/audit under the recorded gate and dependency review; no secret output |
| Restore resurrects erased data | Erasure ledger/tombstones outside restored snapshot, replay before access | Isolated restore drill with deleted-subject fixtures |

Credential linking must validate provider subject/issuer/audience/state/nonce and PKCE where appropriate. Sign in with Apple is provider-specific (ID token, client-secret JWT); do not assume it is identical to Google OIDC. A matching unverified email must never auto-merge accounts. Email change/recovery should warn old channels, invalidate sensitive sessions and provide a recovery path that does not require perpetual access to corporate email.

RLS, if implemented, uses runtime roles without owner/superuser/BYPASSRLS privileges; test real runtime credentials. Review views and security-definer functions. DB role policy does not substitute for cross-party field authorization. Do not expose database credentials to Next client bundles.

## Data classification and retention

Public: explicitly published articles, profiles and selected company/project fields. Shared confidential: accepted terms and permitted transaction evidence. Party private: negotiation floors, budgets, internal correspondence. Personal private: notes/preferences/private work. Restricted: credentials, tokens, payment references, sensitive identity evidence. Assets inherit their own classification and parent access. Never log raw secrets, entire mailboxes, payment data or private model prompts by default.

Collect minimum data with purpose and source. Public people require publication/consent policy; public availability is not permission to scrape or republish portraits. Research participation is voluntary; separate employer reporting from individual interviews. Determine export/deletion exceptions and lawful evidence retention with qualified policy review; no compliance assertion is made here. Encrypt transport/storage, separate key custody and rotate provider grants; concrete providers remain unselected.

Primary references: [OWASP authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), [password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [API object authorization](https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/), [PostgreSQL RLS](https://www.postgresql.org/docs/18/ddl-rowsecurity.html).

[RAG security/evaluation](retrieval-evaluation.md) is mandatory: split audiences before embedding, no mixed private ANN, three authorization gates, serialized egress/delivery/revocation, current citation checks, derived audience intersection, prompt-injection isolation and tombstone replay. Real RLS/pool/provider/race tests remain pending.
