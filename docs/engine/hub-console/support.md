# Support workspace: serving users lawfully

Status: **Live** as an API ([support module](../../../apps/api/src/modules/support/README.md), SUP-001; not deployed); the console screens are **Proposed**; the company card, communications history, data rights flows and metrics are **Proposed** (follow-ups, PRV-001 for exports and erasure). Contract: `SupportAccountSummarySchema`, `AccountServiceActionSchema`, `ACCOUNT_SERVICE_ACTIONS`, `COOLING_OFF_ACTIONS` in [`hub.ts`](../../../packages/contracts/src/hub.ts); `CaseAccessGrantSchema`, `AccessLogEntrySchema`, `ProjectionClassSchema` in `admin.ts`; `PolicyDecisionSchema` in `access.ts`. Screens HC-30…HC-36 in [screens](screens.md#support). Backend: SUP-001.

People will lose access, get stuck, ask what happened to their data, and want to leave. Support must solve these problems quickly and kindly **without** becoming a back door: no staff member ever becomes the user, reads private data by default, or changes how someone signs in without evidence, a second person and time for the real owner to object.

## What support can see without any grant

**Lookup** finds a person or a company by exact e-mail (matched on the normalised value; the result never confirms existence to anyone without support permission), by name, by company name, by legal identifier (EIN, STIR, …) or by id. Every lookup is recorded in the access log with the case it serves (a case is created first or chosen).

The **account card** (`SupportAccountSummarySchema`) is an allowlist projection:

| Field | Shown as |
|---|---|
| Name | Display name |
| E-mail | Masked (`sy***@example.org`), plus verified or not |
| Account state | Active, locked, pending verification, suspended, deletion requested, erased |
| Second factor | Enrolled or not, number of methods; never the methods' secrets or devices |
| Sessions | Count of active sessions; never tokens, IP addresses or a location trail |
| Recovery | None, requested, held for review, cooling off |
| Employer | Company name and role, as public membership data |
| Entitlements | Offer codes and validity (economic rights, not roles) |
| Open support cases | Count, with links to cases the agent may open |
| Consents | Kind, version, given or withdrawn, date |

The **company card** shows the company's public page data, claim and verification state, members who chose to appear (public roles only), the representative's state and accountable person, and open cases. It never shows the company's private projects, RFQs, quotes, budgets or messages.

**Communications history** shows delivery metadata only: which template version was sent, when, to which channel, and its delivery state. It never shows message bodies of participants' correspondence; for notifications it shows the template, not the rendered private values.

## Servicing actions

| Action | Who | Conditions |
|---|---|---|
| Resend verification | Support agent | Rate-limited; to the address on file only |
| Unlock after lockout | Support agent | After the lockout reason is understood; the person is notified |
| Revoke all sessions | Support agent | Reason required; the person is notified on every verified channel |
| Require password reset at next sign-in | Support agent | Same |
| **Rebind recovery e-mail** (corporate mailbox lost after leaving a company) | Support agent requests, support lead approves | Evidence (identity check recorded as a check, never stored), a **second person**, and a **72-hour cooling-off** during which every verified channel is told and the change can be cancelled (`COOLING_OFF_ACTIONS`) |
| **Reset second factor** | Same as above | Same, plus all sessions revoked when it takes effect |
| Start data export | Privacy officer (support agent opens the request) | The export goes to the person, not to staff |
| Open deletion request | Support agent | Decided by the privacy officer; executed by two people |
| Send a guided task | Support agent | A structured step-by-step task the person performs themselves in their own session ("re-invite your colleague: open Company → People → Invite") |

Staff never service their own account (`subjectPersonId ≠ requestedBy`), and every action is tied to a support case and recorded with its reason.

## Memberships, entitlements and usage

The account card links to membership history as the person would see it (employer and role changes with dates), entitlements and **usage against quotas** (for example "agent runs this month: 24 of 30 free"), so support can explain limits. Usage is shown as totals per offer and period, never as an activity timeline.

## Data rights requests

| Request | Flow |
|---|---|
| Access and export | Opened from the account card or by the person in their settings; produced by the same projection serializers as the product (the person's own data, never counterparties' private fields); delivered to the person's account download area and announced by e-mail; staff see only status and deadline |
| Correction | Routed to the module that owns the data; sourced facts link to their source's correction path |
| Deletion and erasure | Decided by the privacy officer, executed by two people; legal holds and lawful evidence preservation (accepted terms another party relies on) reconciled; tombstones to indexes and peers |
| Opt-out of sale or sharing (US state laws such as CCPA/CPRA) | The engine does not sell personal data and does not share it for cross-context advertising; the hub still honours the request and Global Privacy Control signals as a recorded preference and confirms it |
| Objection (data mining) | Routed to the privacy officer with the dataset and record |

Deadlines come from the hub's privacy settings (US example: 45 days for consumer requests under CCPA with one extension; Samarkand: from the pack once confirmed) and are shown on the requests queue.

## Support cases and case grants

A **support case** has a subject (person or company), a reason, a requester (the person themselves, or staff on their behalf), a thread with the person (inside the case context, not a generic inbox), and a state. When diagnosing requires seeing private objects:

1. The support agent requests a **case access grant**: named objects (up to 100 ids of one type), projection class (`diagnostic`, `support_private_limited`, `evidence`), purpose, expiry (at most 72 hours).
2. A **different person** approves (support lead). The approval binds the exact request digest.
3. Reads go through the `staff_case` projection with `negotiation_private`, `credentials` and `payment_refs` always excluded; every read is an `AccessLogEntry`.
4. Where policy says so, the person sees that support viewed their objects, when, and why.
5. The grant expires or is revoked; nothing persists beyond it.

## Why there is no impersonation, and what replaces it

"Log in as user" would let staff act with the person's authority (sign, send, accept, spend), read everything they can read, and leave actions attributed to them. It defeats mandates, budgets, audit and privacy at once. The console has **no** such route, control or API, and the browser test suite scans for one.

What support uses instead:

| Need | Alternative |
|---|---|
| "What does my page look like to others?" | **View public projection**: renders exactly what an anonymous visitor sees |
| "Why can't my colleague see this project?" | **Access explainer**: for a principal and an object, returns the policy decision as reason codes (no participation, membership ended, grant expired, mandate revoked, projection not published) without showing the object's private content (`PolicyDecisionSchema` reasons) |
| "Something is broken on my screen" | **Diagnostic snapshot**: the person clicks "Share diagnostics with support" in their own session; it attaches page id, versions, feature flags, recent error codes and request ids to the case, and only the objects the person explicitly selects |
| "Please fix my settings" | **Guided task** the person performs, or a servicing action from the table above |
| "Look at my RFQ, the supplier says they never got it" | **Case grant** on the named RFQ and invitation with the diagnostic projection |
| "Reproduce the bug" | A **demo hub** or fixtures with synthetic data; never the person's account |
| "Do it for me" | The person's own agent, under their mandate, if they choose |

## Metrics

Cases opened and closed, median time to first response and to resolution, grants requested, approved, declined and expired, servicing actions by kind, data rights requests by kind and deadline compliance. All aggregate; no per-staff productivity ranking (no surveillance of employees, including support staff).

## Acceptance (when implemented)

- No endpoint creates a session for another person; no console route or control offers it (scan).
- A staff member without a case grant gets "not found" for every private object through every support path.
- Second-factor resets and recovery rebinds without evidence, without a different approver, or effective sooner than 72 hours are refused; the person is notified on every verified channel.
- The account card response contains only allowlisted fields (strict schema test with leak probes).
- Exports reach the person, not staff.
