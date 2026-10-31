# Transactional mail (MAIL-001)

Status: **Live** in code and tests, not deployed anywhere. No mail server or provider account is configured by this package; the default transport is the recording fake.

Verification, "already registered", recovery, e-mail change, membership invitation and security notices leave through the outbox. The request never talks to a mail server.

```text
API transaction (identity change)              worker
  audit rows + identity outbox intents
  mail_delivery row (address, sealed token)  -> relay: mail.requested -> mail.enqueue_delivery
  outbox mail.requested { } (id only)            (inbox receipt per delivery id) -> job mail.deliver
                                                 claim -> render (recipient's language, hub brand)
                                                 -> transport (smtp | fake | log) -> sent / retry / unknown
```

## Guarantees

| Property | How |
|---|---|
| A rolled-back change sends nothing | The delivery row and its outbox event commit or roll back with the identity change (`mailDeliveries.record`) |
| A slow or broken mail server never fails or slows a request | The API only inserts rows; delivery runs in the worker (tested with a stalled SMTP sink) |
| At most one message per intent | The outbox handler records an inbox receipt keyed by the delivery id before it queues the one `mail.deliver` job; the job claims the row under a row lock, refuses rows owned by another job and rows already final |
| Unknown outcomes are never resent blindly | A timeout or disconnect after the message body was sent parks the job as `outcome_unknown`; `npm run reconcile -w @trustwork/worker` decides; `mail.settle` then copies the verdict to the delivery |
| No token in the outbox, logs or job rows | The outbox payload is `{}` (the aggregate id is the delivery id); the token is sealed (below); SMTP replies are stripped of addresses before they reach `last_error` or logs |
| No personal data after delivery | When a delivery is final (`sent`, `suppressed`, `rate_limited`, `expired`, `failed`) the address and the sealed token are cleared; a database CHECK enforces it |

## One-time tokens

`auth_token` keeps only the SHA-256 of each token, as before. The plain token travels from the API to the worker sealed with AES-256-GCM in `mail_delivery.sealed_secret`: key derived by HKDF-SHA-256 from `MAIL_SECRET_KEY` (configuration shared by the API and the worker, never stored in PostgreSQL), random nonce, the delivery id as associated data. A database dump alone therefore yields no usable token, a ciphertext copied to another row does not open, and the ciphertext is erased once the delivery is final. A token whose expiry passed before delivery is not mailed (`expired`). Outside production both processes fall back to a public development key so a local stand works without setup; production refuses a missing key and the development key.

## Language and brand

- The dictionaries are the `mail` namespace in `locales/<tag>/mail.json` (the INTL-004 layout `<tag>/<namespace>.json`), English as reference, every engine language complete. `npm test` fails when a language lacks a key, has an extra key, changes a message's parameters or contains a placeholder; the worker refuses to start when a configured hub language is incomplete, and rendering never falls back to English.
- The language of a mail is the first language the hub serves from the causing request's `Accept-Language` (exact tag, then the same language: `uz` finds `uz-Latn`), else the hub default (`MAIL_DEFAULT_LOCALE`). Mail caused by someone else (the lockout notice, an invitation) carries no preference and uses the hub default.
- Messages name the brand only through `{brand}`. The brand is configuration: `MAIL_BRAND_NAME`, else the dictionary's `brand.name` ("Trustwork"); a brand overlay (`TRUSTWORK_BRAND`, default `stroyreputation-ru` like the web build, `none` disables it) replaces it in its own languages only, so the Russian name appears only in Russian mail.
- Links are built from `MAIL_PUBLIC_ORIGIN` and the configured path templates only; links in a language other than the hub default carry `?lang=<tag>` (the web app's language switch).

## Transports

`MAIL_TRANSPORT` chooses one implementation of `MailTransport`:

| Transport | Use |
|---|---|
| `fake` (default) | Records messages in memory and sends nothing; scriptable failures for tests |
| `log` | Prints the rendered text part, links included, to stdout; development only (refused with `NODE_ENV=production`) |
| `smtp` | Any SMTP submission server: STARTTLS required by default (`tls` for port 465, `none` only for a loopback relay or outside production), AUTH PLAIN or LOGIN never sent without TLS to a remote host, certificates always verified (`MAIL_SMTP_CA_PEM` adds a private trust anchor) |

Outcome mapping: a 2xx after the message body is acceptance (the queue id is stored as `provider_message_id`); 4xx or a network failure before the body is sent retries with backoff; 5xx is final (`failed`), and 550/551/553 at `RCPT` is also recorded as a hard bounce; a timeout or disconnect after the body is an unknown outcome. Every variable is documented in `config.ts`.

## Bounces, complaints and suppression

Transport feedback is normalised to `{ provider, eventId, kind: delivered | bounce | complaint, bounce: hard | soft, deliveryId }` (the delivery id comes from our `Message-ID: <delivery id>@<sender domain>`, see `deliveryIdFromMessageId`) and queued with `submitMailFeedback` as a `mail.feedback` job. Each event is recorded once in `inbox_receipt` (`mail.<provider>`, `feedback`, event id); the delivery keeps its most severe feedback; a hard bounce or a complaint adds the address hash to `suppression_entry`, and a suppressed address receives nothing and costs no connection. Provider webhooks and bounce mailbox readers are adapters for COMMS-001/CHAN-001; they call `submitMailFeedback`.

## Limits

- Per recipient: at most `MAIL_RECIPIENT_LIMIT_PER_HOUR` (10) messages per hour; claims are serialised per address with an advisory lock, so concurrent workers cannot overshoot; messages beyond the window are dropped as `rate_limited`, not deferred (a person asks again later instead of receiving a burst).
- Per hub: at most `MAIL_SEND_LIMIT_PER_MINUTE` (120) messages per minute; beyond it the job retries with backoff (8 attempts).

## Metrics

`trustwork_mail_deliveries_total{template,result}`, `trustwork_mail_feedback_total{kind}`, `trustwork_mail_settled_total{outcome}`: counts only, never per-person data.

## Tests

`tests/worker/mail/`: dictionaries and rendering in every language, the brand rule, MIME and SMTP against a local sink (refusals, a server that never greets, a server that swallows the body, abort), configuration guards, sealing; on real PostgreSQL with the real API and worker: sign-up, recovery and invitation end to end through SMTP, a stalled server while requests keep their latency, outcome-unknown parking and reconciliation, duplicated outbox events, redelivery, extra jobs and two concurrent workers (one message per intent), RCPT refusals, feedback receipts and suppression, the per-recipient window, expired tokens and the role boundaries of the new tables.

## Not in this package

Versioned, editor-managed templates and their activation (COMMS-001; the dictionaries here are the engine defaults), hub sender identities with SPF, DKIM and DMARC, provider webhooks and bounce mailbox parsing, unsubscribe for non-transactional mail, and a stored language preference per person (the language comes from the causing request).
