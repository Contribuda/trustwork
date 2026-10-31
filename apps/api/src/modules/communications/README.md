# Communications module: context threads, notifications, channel grants and templates (COMMS-001)

Requirement R08 ([handbook](../../../../../docs/engine/communications.md), [data model section 13](../../../../../docs/data/model.md)). Contracts: [`communications.ts`](../../../../../packages/contracts/src/communications.ts). Storage: [`packages/data/migrations/communications`](../../../../../packages/data/migrations/communications), [`packages/data/src/repositories/communications.ts`](../../../../../packages/data/src/repositories/communications.ts).

Status: **Live** in code and tests (threads, messages, notifications, preferences, channel grants, templates, e-mail through MAIL-001, inbound intake); messenger and SMS adapters are **fakes only** (no provider account anywhere); hub sender identities are a table with their second-person rule (**Proposed**, no routes).

All mutations: authenticated session, `X-Trustwork-Request` with same-origin metadata, `Idempotency-Key`; every route completes its idempotency record inside its own request transaction (BE-005) and is crash-tested (`tests/backend/idempotency/cases/communications.ts`). Errors use the contract envelope; specific reasons are in `details.reason`.

## Conversations belong to the work

There is no generic inbox. A thread always names its context: `project`, `rfq`, `quote`, `agreement`, `order`, `task_request` or `task_assignment` (the other context kinds of the data model join when their modules exist). A guard trigger refuses a thread whose context does not exist, for every role.

Who reads a thread is derived live from the context, never copied (`comms_party_side`):

| Context | Owner side | Counterparty / participant |
|---|---|---|
| `project` | the owner person, members of the owning company | live, non-staff participations (person, or the participating company's members) |
| `rfq` | owner party deal managers, party-private participations with `read.party_private` | invited parties; each RFQ thread is between the owner side and **one** counterparty |
| `quote` | buyer and RFQ owner side | the seller |
| `agreement`, `order` | buyer and RFQ owner side | the seller |
| `task_request` | the owner | invited, offering or (open board) any signed-in person; one thread per counterparty |
| `task_assignment` | the owner | the assignee |

A public project does not open its threads. Everyone else gets `404 access.not_found`, including for a context that does not exist (existence is not disclosed). Losing the context (participation revoked, membership ended) closes its threads and hides its notifications on the next request.

| Route | Result |
|---|---|
| `GET /v1/threads?contextKind=&contextId=` | `ThreadList` of one context (no listing without a context) |
| `POST /v1/threads` | Opens the context's thread with a first message, or appends to the existing one (one thread per context and counterparty; concurrent openings meet on the unique constraint) |
| `GET /v1/threads/:id` | `ThreadView` with messages, links and the authors' display names |
| `POST /v1/threads/:id/messages` | Appends a message as the person, as their employer (`onBehalfOfCompany`, deal managers only) or as their agent under a `communicate` mandate (`actor: { via: 'agent', mandateId }`; the AST-001 mandate store decides, module key `correspondence`) |

Messages are append-only. `message_link` names the object versions a message discusses.

## Notifications are not mail

A new message is announced by the database (`comms_fanout_message`): it computes the parameters itself (`contextKind`, `threadSubject`, `authorName`) and tells every other person who is a party of the thread right now (the thread's own people and the named people of the context, each checked for themselves and their active employer). A notification carries exactly the parameters its template declares (`NOTIFICATION_TEMPLATES`, enforced by a CHECK for every role): never a message body, a price, a ceiling, a floor or a private note. The read policy checks the recipient's right to the linked context again on every read.

| Route | Result |
|---|---|
| `GET /v1/notifications?limit=&cursor=&unread=` | The person's notifications, newest first, with the unread count |
| `POST /v1/notifications/:id/read`, `POST /v1/notifications/read-all` | Read marks (set once) |
| `GET`, `POST /v1/me/notification-preferences` | Frequency per category and channel (`email`, `messenger`, `sms`); security and legal notices by e-mail cannot be turned off; daily and weekly digests are stored but not sent yet |
| `POST /v1/me/mail-unsubscribe` | Adds the person's verified address to MAIL-001's `suppression_entry` (`unsubscribe`): no more non-transactional mail; security and legal notices still arrive |

`CommunicationsService.notify(trx, …)` is the producer for other modules (non-thread templates): the database requires the caller and the recipient to be parties of the linked context, or the recipient to be the caller for an unlinked account notice.

## Deliveries

- **E-mail** goes through MAIL-001: the API renders the hub's active template version in the first of the recipient's profile languages the hub has a text for (else the hub default), and `comms_enqueue_mail` writes the `mail_delivery` row (template `notification`) and its `mail.requested` outbox event in the same transaction. The recipient address is read inside the definer and never reaches the API. A suppressed address gets no non-transactional mail (`suppressed_<reason>`); an unsubscribe never blocks a transactional notice; bounces, complaints and legal entries block everything (the worker checks again).
- **Messenger and SMS** need a live `channel_grant` whose scope covers the context kind and `notify`. After COMMIT the message goes through the `ChannelAdapter` (only `FakeChannelAdapter` exists) with a reply token; the outcome is recorded (`sent`, `failed`, `outcome_unknown`) with a `send_receipt` and never retried blindly. A crash between COMMIT and the send leaves the delivery `queued` (never sent twice). Real adapters (CHAN-001) should move the send into the worker.
- No active text in a language the hub serves: the delivery is `skipped` (never an English fallback the hub did not choose).

## Inbound intake (adapters only)

`CommunicationsService.ingest(event)` takes a normalised `InboundMessageEvent`. The reply token (only its SHA-256 is stored) names the thread, the person and the grant; a token whose grant was revoked, whose grant lacks `reply`, or that arrives through another provider is refused. The message is written **as that person** under RLS (a person who is no longer a party is refused), with `direction = inbound`, `untrusted = true` (CHECK and trigger), and `(provider, providerMessageId)` unique: a repeated provider event changes nothing, also under concurrency. The text is stored and shown, never parsed for commands. There is no public webhook route yet (CHAN-001).

## Channel grants

`GET`, `POST /v1/me/channel-grants` (step-up), `POST /v1/me/channel-grants/:id/revoke`. A grant names the provider (`telegram`, `whatsapp`, `sms`, `other`), the account (kept for the adapter, shown masked) and scopes (`contextKinds`, `actions: notify | reply`); never a whole mailbox. Revocation happens once.

## Templates (hub staff)

| Route | Who |
|---|---|
| `GET /v1/hubs/:hubId/message-templates/:key` | `admin.notifications.template.edit` or `admin.config.edit` at the hub |
| `POST /v1/hubs/:hubId/message-templates/:key/drafts` | `admin.notifications.template.edit`: drafts one language of the next version (or of a version that is still a draft); placeholders only from the template's parameters and `{brand}` |
| `POST /v1/hubs/:hubId/message-templates/:key/versions/:version/activate` | `admin.config.edit`: refused (`422 template_incomplete`, `details.missing`) unless every hub language exists, and (`403 access.second_approver_required`) when the activator drafted any language of it (also a CHECK); the previous version is retired in the same transaction |
| `GET /v1/hubs/:hubId/deliveries/counts` | Counts per channel and state, never per person |

Hub languages: `COMMS_HUB_LANGUAGES` (default the seven engine languages), default language `COMMS_DEFAULT_LANGUAGE` (`en`), the served hub `TRUSTWORK_HUB_ID`, `{brand}` from `COMMS_BRAND_NAME` (default Trustwork). Template routes do not yet require the console's elevated session (follow-up with the hub console communications screen).

## Tests

`tests/contracts/communications.test.ts` (vocabulary, parameter allowlist, preferences, grants, placeholders, languages), `tests/communications/database.test.ts` (no thread without a context for any role, derived access, append-only and untrusted inbound, concurrent duplicate provider events, notification parameters and producers, definer-only tables, second-person rules, SQL mirrors of the contracts), `tests/communications/api.test.ts` (the whole flow through HTTP with negative authorization, RFQ competitor isolation, forbidden fields, templates in every language, mail through MAIL-001 and suppression, fake messenger delivery, untrusted and de-duplicated inbound replies under concurrency, losing the context).
