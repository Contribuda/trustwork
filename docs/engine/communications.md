# Communications and notifications

Normative requirements: [Communications and notifications](modules/communications-and-notifications.md), [Mobile and offline](modules/mobile-and-offline.md). Participants: [who uses what](participants/README.md).

Requirement R08. Status: context threads, messages, notifications (page and bell), preferences, channel grants, templates and e-mail delivery through MAIL-001 are **Live** in code and tests (COMMS-001, not deployed; [module README](../../apps/api/src/modules/communications/README.md)); messenger and SMS channels exist as **fake** adapters only; hub sender identities are **Proposed**.

## Conversations belong to the work

There is no generic inbox. Every message belongs to a context: an RFQ, a quote, an agreement, an order, an introduction, a project, an event registration or a support case. Opening the context shows its thread together with the versions, files and decisions it is about. This keeps the history where it is useful and keeps access rules simple: whoever may see the context may see its thread, and nobody else.

| Element | Meaning |
|---|---|
| `context_thread` | The conversation of one context |
| `message` | Direction, author (person, agent on behalf of a person, or system), body, attachments, source time |
| `message_link` | Links a message to object versions it discusses |
| `channel_grant` | A person's permission to connect an external channel with scopes, revocable |
| `send_receipt` | Provider evidence that a message left the platform |

## External channels

Many people will keep using e-mail and messengers. The engine connects them through adapters, never by taking over a mailbox:

- A **channel grant** names the provider, the account, the scopes (for example "send and receive in threads of RFQ contexts") and can be revoked at any time.
- Inbound messages are matched to contexts by reply tokens and stored with provider event IDs so duplicates are ignored.
- Existing e-mail is preserved; the platform does not delete or move your mail.
- Inbound content is untrusted: it can inform your agent's drafts, never authorize an action.

Which channels a hub offers is a hub setting: e-mail everywhere; messengers popular in the territory where their terms allow business use (for example WhatsApp in Brazil, Mexico and India, LINE in Japan, Telegram in Uzbekistan); SMS for one-time codes where sender registration rules are met.

## Notifications are not mail

The bell shows **notifications**: short, actionable signals with a link ("Quote v3 received for RFQ Facade panels", "Your claim was approved", "Event starts tomorrow"). A notification is not a conversation and carries no private content beyond what the recipient may see. People choose frequency per category; transactional notices (security, legal) cannot be turned off.

## Templates

Notification and e-mail texts are **versioned templates** per language, edited by the hub's editors and activated by operations staff, previewed with synthetic data. Every template exists in every language the hub serves; a missing translation blocks activation instead of sending English to a reader who chose Polish, Georgian or any other language.

## Hub sender identity (Proposed)

A hub configures its own sending domain (with SPF, DKIM and DMARC), reply-to addresses and, where used, an SMS sender ID registered under local rules. Deliverability and bounce handling are visible in the hub console as counts, never as per-person tracking.

## Invariants

- No message is visible outside its context's access rules.
- No marketing message is sent without a lawful basis recorded for the recipient.
- Duplicate inbound events never create duplicate messages.
- A notification never contains private values the recipient may not read.
