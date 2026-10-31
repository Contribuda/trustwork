# Events: attend and host

Normative requirements: [Events](modules/events.md). Participants: [who uses what](participants/README.md).

Requirement R32. Status: event list with filters, event page, registration form, ticket page, demo payment and calendar file are **Demo** (`/events`, `/events/:slug`, `/register`, `/ticket`, `/pay`, `/calendar.ics`); everything below about organizing, check-in, payouts and partner meetings is **Proposed**.

The industry meets in person: exhibitions, conferences, site visits, a supplier's open day, a training for installers, an evening meetup of young engineers. Events turn readers into a community. Every participant can attend events, and anyone the hub allows can host one.

## What an event is

| Field | Notes |
|---|---|
| Type | `conference`, `exhibition`, `webinar`, `meetup`, `training`, `site_visit`, `open_day`, `competition`, `other` |
| Format | `offline`, `online`, `hybrid` |
| Time | Start and end in UTC plus the event's time zone; displayed in the reader's language with `Intl` |
| Place | City, region (ISO 3166-2), venue with address and accessibility notes; for online events a link delivered only to registrants |
| Organizer | Editorial team of the hub, a company, or a person; co-organizers listed |
| Programme | Sessions with times, rooms or streams, speakers |
| Speakers | Linked to public profiles only with their consent; otherwise a name and role line the speaker approved |
| Tickets | Ticket types with price versions, quotas and sales windows |
| Capacity | Overall limit; registered count shown only as the organizer allows |
| Topics and entity links | Same taxonomy as publications, so events appear in topic feeds |
| Related publications | Announcements, reports, recordings and slides as publications |
| Sponsors and exhibitors | Labelled as such; never affect ranking or matching |

### Lifecycle

```text
draft → in_review (hub policy) → published → registration_open ⇄ registration_closed
      → running → finished → materials_published → archived
published | registration_* → postponed (new dates) | cancelled (with refunds per policy)
```

## Attending (Demo today)

1. Find events by date, type, format, topic and city; the home feed shows upcoming events for the reader's interests and region.
2. Open the event: programme, speakers, venue, tickets, organizer card, related reading.
3. **Register**: choose a ticket, name the attendees (one person can register colleagues), answer the organizer's questions, accept the organizer's terms and the data-sharing notice.
4. **Pay** if the ticket is paid. The demo page imitates a successful payment and says so; real payment uses the hub's payment adapter.
5. **Ticket**: a page and a QR code per attendee, add-to-calendar file, reminders.
6. **After the event**: materials, recordings, a certificate of attendance when the organizer issues one ([Learning](learning.md#certificates)).

## Hosting (Proposed)

### Who may host

Each hub sets a **hosting policy** in its console:

| Policy | Typical use |
|---|---|
| Editorial only | A new hub that wants to control quality first |
| Verified companies and editorial | The common default: a company with a verified badge may host |
| Any signed-in person, with review | Communities and meetups; every event goes through review before publication |
| Any signed-in person, without review | Mature communities with active moderation |

Hosting is a capability, not a role: a person can host a meetup without any company, and a company member hosts on behalf of the company only with the company's `publish` grant.

### Organizer tools

- **Event editor** with programme builder, speaker invitations (the speaker accepts and chooses what is shown), ticket types and price versions, registration questions, capacity and waitlist.
- **Registrations**: list, export through the same projection code (attendee personal data only to the organizer, only the fields the attendee agreed to share), manual add, cancel, move to waitlist.
- **Communications**: event announcements and reminders through the platform's notification templates; no free-form mass mail to people who did not register.
- **Check-in**: a mobile web page for the organizer's staff that scans ticket QR codes offline-first and syncs; shows name, ticket type and a check-in time; duplicate scans are flagged.
- **Materials**: attach recordings and slides as publications; issue attendance certificates.
- **Feedback**: a short private survey to attendees; results go to the organizer only. Public event ratings are deliberately not built, because they would become a reputation signal without evidence rules.

### Money

- Ticket prices are **price versions** in the hub currency (for example USD, MXN, EUR or INR), immutable once a ticket is sold.
- Payment goes through the hub's payment adapter. Where the hub acts as a marketplace, ticket payments go through the licensed provider's connected accounts directly to the organizer, and the hub's fee from its published price version is taken as an application fee by the provider; neither the engine nor the hub ever holds ticket money (ADR 010 decision 20); taxes on tickets follow the country facets ([Country specifics](country-specifics.md#tax-and-invoicing)).
- Refund rules are part of the organizer's terms, shown before payment; cancellation by the organizer refunds automatically through the provider.
- A payment whose outcome is unknown is reconciled, never charged twice (same reliability rules as orders).

## Partner meetings at events (Proposed)

Events are where partnerships start, so the engine helps people meet with purpose:

1. Attendees who opt in publish a short **meeting profile**: what they offer, what they look for, topics.
2. During registration and up to the event, attendees browse the opted-in list and **request meetings** in time slots the organizer defines.
3. The other side accepts or declines; nobody sees who declined them.
4. A personal schedule merges sessions and meetings; the organizer sees only counts and room allocation.
5. Your agent can propose meetings that fit your goals within its mandate (for example "suggest up to five meetings with facade subcontractors"); it never accepts on your behalf unless the mandate says so.
6. After the event, a meeting can become an [introduction](partners-and-matching.md#introductions) or an RFQ invitation.

## Events in the mesh (Proposed)

Public events federate. A city hub's meetup appears in the country hub's calendar with the city hub named as home; registration happens on the home node, and the attendee keeps their identity through federated sign-in where the hubs peer at `identity` level ([Federation](federation.md)). Paid tickets are always sold by the home node.

## Data model (Proposed)

| Entity | Key fields | Rules |
|---|---|---|
| `event` | organizer party, type, format, times, venue, territory, status, revision | Organizer is a person, a company or the hub editorial team |
| `event_session` | event, title, start, end, stream, speaker refs | Within event times |
| `speaker_consent` | event, person or name, shown fields, accepted_at | No public speaker link without consent |
| `ticket_type` | event, name, quota, sales window | Quota never exceeded under concurrency |
| `ticket_price_version` | ticket type, amount minor units, currency, effective from | Immutable once used |
| `registration` | event, buyer party, answers, consent version, status | Buyer may differ from attendees |
| `ticket` | registration, attendee, code hash, status | Code stored hashed; QR carries an opaque token |
| `check_in` | ticket, scanned_by, at, device | Append-only; duplicates flagged |
| `waitlist_entry` | event, ticket type, person, position | Promotion offers expire |
| `meeting_profile`, `meeting_request` | attendee, offers, looks for; requester, recipient, slot, status | Opt-in only; declines are private |
| `event_material` | event, publication ref | Materials are publications |

## Invariants

- Online links and attendee lists are never in the public projection.
- Ticket quotas and capacity hold under concurrent registrations (row locks or serializable transactions with retry).
- A sold ticket keeps the price version it was sold at.
- A speaker is never shown with a profile link they did not approve.
- Sponsorship and payment never change an event's position in listings or the organizer's reputation.
