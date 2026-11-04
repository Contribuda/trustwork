# Console navigation services (ADM-005)

The backend of the console's navigation layer ([console design](../../../../../../docs/engine/hub-console/console-design.md), sections 3.4, 3.5 and 6.2): the object lookup behind the palette's `#`, one read model of a staff member's work, saved views, notification settings and the rollout stage of a feature flag. Contract: [`console-services.ts`](../../../../../../packages/contracts/src/console-services.ts). Storage and rules: [`packages/data/migrations/console-services`](../../../../../../packages/data/migrations/console-services).

Status: **Live** as an API. The console screens (HUBC-020) still run on fixtures. Tests: `tests/admin/console-services/*`, on real PostgreSQL under the runtime role, and the crash cases in `tests/admin/crash-routes.ts`.

## Routes

Every route under `/v1/admin/console` needs a signed-in session and a live elevation. Reads take a target (`hubId`, `nodeId`, or neither for the platform) and answer about exactly that target. Mutations are console commands: CSRF header, `Idempotency-Key`, contract version and a reason.

| Route | Who | Result |
|---|---|---|
| `GET search?ref=` | staff covering the target | `{ hits }`: the object with this id, request id, case or audit number, or flag key, if the reader may read it |
| `GET work?view=waiting\|mine\|assigned\|done` | staff covering the target | `{ view, items, truncated }`, each item with the reason it is the viewer's |
| `GET work/count` | staff covering the target | `{ waiting, truncated }`: the rows of "Waiting for me" |
| `GET views?surface=` | staff covering the target | Own views, and views of a team the reader is in |
| `POST views`, `POST views/:id`, `POST views/:id/remove` | the owner | Save, change on the revision seen, remove |
| `GET notifications`, `POST notifications` | the person | Their own settings: e-mail categories and quiet hours |
| `GET flags` | staff covering the target | Flags with stage and expiry, expired ones included |
| `POST flags/:id/stage` | `admin.flags.edit` at the flag's scope | Moves a stage; audited |
| `GET /v1/flags/active` | any signed-in person | The flags in force for them at the hub this API serves |

## What search never does

- **It reads no participant data.** It looks only at console tables, and no branch selects a free-text column: not a case summary, an incident title, an approval reason or a grant purpose. Each hit is identifiers and codes, enforced by a strict output schema and by a walk of the schema (`schema-walk.test.ts`) that fails on a free string or a personal field name.
- **It takes no free text.** A request is one identifier: a uuid, a number or a lower-case key. Anything else is refused and not repeated. Plain words and `@` names stay in the browser, filtered from the viewer's own access and the staff directory, so an address or a name typed into the palette is never sent; that is why sections and commands are not an API. Participant lookup stays in the support workspace, with a case and an access-log entry.
- **Missing and unreadable are the same bytes.** Both answer `200 { "hits": [] }`. Every branch runs on every call; a person who is not staff covering the target gets the same answer without any branch running. A lower-case word that happens to be a name is compared with flag keys only.
- **Nothing is computed from rows the reader cannot see.** Lookups are exact, so there are no suggestions. There is no count, facet or total. Hits come in a fixed order of kinds, then by a number or id in the hit. The work count is the length of the list the reader would get.
- **It does not follow a person.** An audit event is found by its id, sequence or request id, never by `object_id`, so a person's id is not a way into the audit. A person's id finds only a staff member of the hub, for a reader of the staff directory; a participant is as absent as an unknown id.

Two gates decide a hit: row-level security, because the function is an invoker function running as the staff member, and the owning read permission, stated in each branch. The second is there because some policies also admit the participant side of a row. A staff member who is the subject of a moderation case, the requester of a support case or an appellant reads those on their own screens, not as console objects. Cases and appeals about the reader, their employer or a declared party are not found (`admin_conflicted`).

## Work items

| View | Rows |
|---|---|
| `waiting` | Second-person approvals and recovery escalations the viewer could decide now; case grants; access-review items |
| `mine` | Approvals and case grants the viewer asked for and can still use; pending role activations |
| `assigned` | Support and moderation cases assigned to the viewer; appeals they may decide; incidents they opened; pipeline alerts they acknowledged |
| `done` | Their decisions of the last 90 days that they may still read |

A row is here only while the object's read rule admits the viewer, so a lost role takes the work with it, whatever `assigned_to` says. `waiting` also leaves out what the deciding command would refuse: one's own request, the different-role rule of the staff actions in full mode, an account recovery about oneself or a conflicted party, an access-review item about one's own access, and after the deadline every reviewer but the scope's owner role. The reason a person gave, the change and a grant's purpose stay on the object's own read; for an approval that is `GET /v1/admin/approvals/:id`.

Operator Agent team review items are not a source yet: AGT-030 has no table to read. Appeals have no assignee in the schema, so they are the work of whoever may decide them; there is no incident roster, so "incidents I am on" means those the viewer opened; pipeline alerts have no owner, so "alerts I own" means those the viewer acknowledged.

## Saved views

A view remembers filters, columns and a sort for one surface at one scope, for its owner or for a team: the holders of one role covering that scope. It stores no rows, counts or search text. What it shows is computed for each reader under their own permissions when they open it. Every filter, value and column comes from a list per surface (`CONSOLE_VIEW_VOCABULARY`, and `console_view_vocabulary()` for every writer), because no pattern can tell a code from a name made to look like one. So a view holds no identifier and nothing typed, and sharing it cannot tell a team who or what its owner was looking at. A screen that needs a new filter adds it to both lists. The name is the one free text: it refuses an address or a telephone number, but a person's name cannot be told from any other words, so that stays with the writer. Only the owner changes a view, while they are staff covering the scope and in the team.

## Flag stages

Off, staff only, a share of people (1, 5, 25 or 50 percent) and on, in `feature_flag_rollout` beside the flag. A new flag starts off; flags from before this module keep working at stage on. A stage says only for whom a flag is in force, so the rule that flags never touch access, projections, egress or ranking is unchanged. The work package says a share of sessions; the bucket follows the person instead, because a session bucket lets a client reach a 1 percent share by signing in again.

- **Off is immediate.** One person, no second approval and no revision to restate, so it cannot be held up. Every other stage restates the revision it was decided on, and every command moves the revision, so a widening prepared before an off is refused. The session read has no cache.
- **A stage cannot target a person.** The command and the table have a stage and a percent and nowhere to put anything else. The bucket is a hash of the flag's generated id and the person id: nobody chooses it, it does not change with a new sign-in, and someone inside 5 percent is inside 25 percent too. Anyone who knows the flag and a person id can compute that person's bucket, which tells them nothing they could use to single that person out: a stage still reaches a whole percent of people.
- **A flag cannot be about ranking, matching, reputation or payment.** Keys with those words at the start of a segment (`matching.v2`, `ui.payment_form`, also `sponsor` and `recommend`) are refused by the table for every writer, and by the API with string values too. Payment never changes the first three, so a flag cannot reach any of them.
- **An expired flag is in force for nobody.** It can be set off and cannot be widened. Extending it brings it back at off with a new revision, whatever stage it had, for every writer of the flag, so a change of date never returns it to everyone. The `flags.set` audit row records the extension.

## Known limits

- Notification settings are stored and read; nothing consults them yet, because the staff notices have no mail templates (a MAIL follow-up, see the platform administration README). **When mail consumes them, quiet hours must exempt the `incidents` and `recovery` categories:** a person's quiet hours may not hold back an incident page or an account recovery notice, which are time-critical and, for recovery, part of the protection of the subject. Opting out of a category by e-mail stays the person's choice; quiet hours only delay, and these two are not delayed.
- A request id that is not a uuid (a client may send one) is found in the audit explorer, not here.
- Only pipeline runs are searched as runs. Assistant runs are participants' data and are never searched; operator agent runs arrive with AGT-030.
