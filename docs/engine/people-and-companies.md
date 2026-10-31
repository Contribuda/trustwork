# People and companies

Requirements R01–R03, R15, R21–R24, R28. Status: accounts, sessions, memberships and public reads are **Live**; profiles and directories are **Demo**; claims and verification recipes are **Proposed**.

## A person is one human for life

Everyone on the platform is a **person** first. A person can read and publish without belonging to any company. Their profile, publications, learning record and authorship credit belong to them and survive every change of job. This is the first promise of the engine: your professional story is yours.

### Signing up and signing in (Live)

- **E-mail and password** is the primary way in. One name field, e-mail, password and terms; no surname, no company details, no tax number at sign-up.
- **No session before the e-mail is verified.** The first session is created by the verification step. Responses are identical whether an e-mail exists or not, so nobody can probe who is registered.
- **Google and Apple** are alternatives behind a neutral provider adapter. A provider identity is the pair `(provider, subject)`, never the e-mail; linking happens only from a recently re-authenticated session or after mailbox proof. Nothing is auto-linked by e-mail. Microsoft and any OIDC provider are designed to plug into the same adapter.
- **Sessions** are opaque random tokens; only their hash is stored. A person sees their sessions and can revoke any or all others. Sensitive actions (changing the password or e-mail, inviting to a company, transferring a project) require **step-up**: re-entering the password within the last ten minutes.
- **Recovery** works by e-mail link. Because a corporate mailbox may disappear when someone leaves a company, recovery to a corporate address can be held for review, and support-assisted rebinding needs evidence and a cooling period.
- Policy values (minimum password length 15 by default, session lifetimes, lockout thresholds) are configuration, and their final values are an open owner decision.

### Onboarding (Demo)

Optional and skippable. A person may say what they want to do (read, publish, buy, sell, find work, host events), which topics and regions interest them, and fill a short profile. Preferences shape suggestions; they confer no rights and no company access. There is no forced tax-number questionnaire.

### The personal profile (Demo)

«Моя страница» has two faces that are always kept apart:

- **The private view**: decisions waiting for you, your projects by role, your agent's mandates, your publications, interests, learning (reading progress, bookmarks, courses, certificates) and history.
- **The public profile**: what anyone can see, edited with a live preview. A person chooses whether the profile is public at all (`profileVisibility`), whether to show the current employer, and whether a portrait is shown (portraits need consent and a licence record).

The public profile shows role line, region, topics, experience, publications, public projects, certificates and, when available, reputation as an author or professional.

## A company is shared by its people

A **company** has one page that its members share: details, wall of publications, people who chose to appear, catalogue, projects, reputation and external website. Editing is permission-scoped: being a member does not mean being able to change the page, the catalogue or prices.

### Membership (Live)

- A person has **one active ordinary employer** at a time; there is no company switcher. History is kept privately.
- Lifecycle: `invited → active → ended`, or `declined | expired | withdrawn`. Inviting, changing and ending a membership require step-up; the last administrator cannot be removed.
- **When employment ends**, the engine revokes company-derived permissions, sessions where needed and every active mandate that relied on company authority, promptly. The person keeps their identity and public contributions. Access to company history is not a personal export right; any residual read-only access must be explicit, scoped and revocable (the default is an open owner decision, O04).
- A company member who wants to buy or sell needs separate, explicit commercial authority. Membership alone never grants spending power.

### Legal identifiers come from the country pack

Companies carry `legalIdentifiers[] { kind, value, status }`. The `kind` is a code from the country pack (`UZ-STIR`, `GE-IDC`, `AM-TIN`, `AZ-VOEN`), and the pack supplies the label, format and validation. A company outside the launch countries uses a free-form registration number until someone contributes its pack. **An identifier is never proof of anything**: anyone can type a public number.

## Sourced, claimed, verified

Directory records exist in three honest states, always visible:

| Badge | What it means | How it is reached |
|---|---|---|
| **From sources** | Derived from a licensed public source; nobody has claimed it | Hub data steward registers the source and activates an import batch |
| **Claimed** | A person asserted that they control or represent the company | Claim submitted with light evidence |
| **Verified** | A trust reviewer approved the claim with documentary evidence | Review of evidence produced by the hub's verification recipe |

A verified badge shows the date and the categories of what was checked ("register record matches", "director identity confirmed", "corporate domain confirmed"), never the documents themselves. **Verified never means good**: it says who the company is, not how well it works. Reputation is a separate, explained signal.

### Claims (Proposed, generalizes the administration design)

Claim evidence is split into two questions:

1. **Who is the claimant?** A verified login identity; optionally a national electronic identity or signature where the hub supports one.
2. **What ties them to the company?** For example a code sent to an e-mail on the company's domain; a match between the claimant and the director or founder in the official register, fetched by the reviewer (an extract uploaded by the claimant proves nothing because it is public); a power of attorney or authority letter signed with a recognised electronic signature; a call-back to the phone listed in the register.

Each hub defines which evidence types exist in its country and how they combine, through **verification recipes** (see [Hub administration](hub-administration.md#counterparty-verification)). The reference recipes for Uzbekistan, Georgia, Armenia and Azerbaijan are decided ([reference recipes](hub-administration.md#reference-recipes-for-the-launch-countries)). Common fallback for small firms on free mail services: register match plus call-back plus a signed authority letter. The badge rises to "claimed" immediately and to "verified" only after the reviewer records the match.

Verification can be revoked with a reason (fraud, expired evidence, legal change); members are notified and every derived projection updates.

### Spending authority is a separate proof

Proving who a company is does not prove that a particular person may bind it commercially. Authority to sign or order (director record, power of attorney) is a separate, later decision (O05, O12).

## The people directory

People appear in the public directory only when their profile is public. People mentioned in publications or listed by companies appear only with consent; consent and withdrawals are recorded, and withdrawal unpublishes. Portraits require a licence record. The engine ships no photographs: avatars are initials, covers are generated artworks, and each deployment registers its own licensed images.

## Designed next

| Item | Status | Notes |
|---|---|---|
| Professional credentials of individuals (engineer licences, welding certificates) checked against hub registers | Proposed | Same evidence model as company claims; shown as "checked on date by hub X" |
| Company branches in several hubs | Proposed | One legal entity, several territories; federation links the records ([Federation](federation.md#entity-links-never-merges)) |
| Employer-independent portfolio of works | Proposed | Personal project participations that survive employment, shown with the project owner's consent |
| Microsoft and generic OIDC sign-in | Designed | Same `(provider, subject)` rule |
| National electronic identity sign-in (where a hub supports it) | Proposed | Adapter per country; see [Country specifics](country-specifics.md#electronic-identity-and-signatures) |

## Invariants checked by tests

- A person cannot have two active employers.
- A former member loses company authority in the same transaction that ends the membership.
- A person's public projection never contains e-mail bindings, provider identities, sessions or token hashes.
- A private profile is not found (404) in the public directory, search and federation feeds.
- An identifier value never upgrades a badge by itself.
