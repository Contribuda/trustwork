# Setup wizard: the first run

Status: **Proposed**. Contract: `SetupStateSchema`, `SETUP_STEPS`, `nextSetupStep`, `HubSchema`, `HubTerritorySchema`, `territoryRestricted`, `HubModesSchema`, `LaunchGateSchema` in [`hub.ts`](../../../packages/contracts/src/hub.ts). Screens SW-1…SW-9 in [screens](screens.md#setup-wizard). Backend: proposed HUB-004.

The wizard turns a fresh node into a **draft hub** that a person can keep configuring in the console. It asks only what cannot be changed casually later or what the engine needs to be safe; everything else has good defaults and lives in the console. A person can stop at any step and resume (the state is stored server-side), and the wizard never skips ahead: `nextSetupStep` returns the first incomplete step.

At the end the hub is in lifecycle `draft`, registration is `closed`, every provider is a **fake**, search-engine indexing is off, and the launch checklist shows what remains. Nothing is public and nothing has been sent anywhere.

## Steps

### 1. Install check (`install_check`)

Shown before anything else, with the setup token in the address.

| Check | Pass condition | If it fails |
|---|---|---|
| Public address | HTTPS (or `localhost` for a trial), matches the configured URL, reachable from the browser | Explain how to set it; the wizard cannot continue |
| Database | Schema at the expected version; runtime role cannot bypass RLS | Show the migration status; link to the install guide |
| Object storage | Write, read and delete of a test object; bucket not public | Show the failing operation |
| Worker | Heartbeat seen in the last minute | Show how to start it |
| Clock | Server time within 30 seconds of the browser's | Warn (signatures, tokens and schedules depend on it) |
| Secret store | KEK present and not a placeholder; external KMS reachable if configured | Block |

### 2. Node identity (`node_identity`)

- **Node name and domain** (for example `build.example.org`). Shown in the federation manifest later.
- **Signing key**: generated now (Ed25519), stored encrypted; the public key and its fingerprint are shown. Used for the federation manifest, signed envelopes and verifiable credentials the hub issues ([modules: credentials](modules.md#reputation-building-credentials-confirmations-methods-and-appeals)).
- **Node jurisdiction**: the country whose law the node operator follows. A restricted place is never offered (the list comes from `@trustwork/country-packs`).

### 3. Hub identity (`hub_identity`)

The heart of "configure your country or city without code".

| Field | US example | Samarkand example | Rules |
|---|---|---|---|
| Starting point | **Generic profile for the United States** (no US pack yet; the wizard says so and links the pack contribution guide) | **Country pack UZ** (version pinned) | A pack brings regions, identifier formats, currency, legal facts and suggested languages with their verification levels; the generic profile brings ISO data only and lets the operator add the rest as local additions |
| Territory | Country `US`, optionally regions `US-TX`, `US-CA`, … and places such as `US-TX:austin` | Place `UZ-SA:samarkand` | Pick from the pack's regions and places or add new places (name per language, optional Wikidata and OpenStreetMap ids). Every code is checked with `territoryRestricted` at country, region and place level, so a place inside a restricted region is refused too |
| Hub name | "Trustwork United States" in `en`, "Trustwork Estados Unidos" in `es-US` | "Trustwork Samarqand" in `uz-Latn`, «Trustwork Самарканд» in `ru` | Required in every hub language; the brand rule applies (Trustwork everywhere, «Строй Репутация» only in the Russian interface) |
| Languages and default | `en` (default), `es-US` | `uz-Latn` (default), `ru` | Chosen from engine locales; a language whose strings are incomplete is allowed in draft but shows its completeness and blocks the `i18n_complete` gate |
| Currency | USD | UZS | From the pack or ISO data; secondary currencies later in the console |
| Time zone | `America/Chicago` (hub default; events keep their own zones) | `Asia/Samarkand` | IANA zone |
| Identifiers | EIN as a local addition (label, pattern `^\d{2}-\d{7}$`, "issuer: IRS", verification level `candidate`); state entity numbers per state later | `UZ-STIR` from the pack | Identifier definitions added here become pack-change proposals the operator can export |
| Brand overlay | None (neutral engine) or an uploaded lettering | None | Contrast checked against every hub language's lettering before the `brand_accessibility_checked` gate passes |

A **"Start from an example"** button prefills the US or the Samarkand example with synthetic values clearly marked as examples; the operator replaces them.

### 4. Operator legal entity (`operator`)

- Legal name, form (for example LLC, corporation, nonprofit association), registration identifier (EIN for the US example, STIR for Uzbekistan), address, contact for legal notices and for abuse and takedowns.
- **Ownership declaration** and **sanctions screening** of the operator through the engine baseline list (US Consolidated Screening List via `packages/compliance`). With the fake screening adapter the result is labelled "fake: not a real screening"; the `operator_recorded_and_screened` gate passes only with a real result later. A potential match never auto-blocks; it opens a review the operator cannot close themselves.

### 5. First administrator (`first_admin`)

- Name, e-mail, password (policy from `PasswordPolicySchema`), e-mail verification.
- **A second factor is mandatory**: TOTP or a passkey (WebAuthn). Ten single-use recovery codes are shown once, with a "I have stored them" confirmation.
- The first administrator receives `hub-owner` for the new hub and `node-operator` for the node. Because a single person holds them, the hub runs in **reduced separation-of-duties mode** and the overview says, permanently, that a second staff member with a different role is needed before soft launch (`two_staff_with_second_factor` gate). Until then, two-person actions cannot be completed: the console explains this rather than letting one person approve their own request.

### 6. Storage and data residency (`storage_residency`)

| Question | US example | Samarkand example |
|---|---|---|
| Where is personal data stored and processed? | United States (any US region) | Uzbekistan (pack note: personal data of citizens stored in Uzbekistan, pending legal confirmation) |
| Where are database, object storage and backups located? | Region recorded per service | Must be in Uzbekistan; the wizard warns if a configured endpoint resolves elsewhere |
| Which privacy regime applies to the notices? | US state privacy laws (CCPA/CPRA in California and similar state laws): enables "Do not sell or share my personal information" handling, Global Privacy Control signals, 45-day response deadline defaults | Uzbek personal data law; deadlines from the pack when confirmed |

The answer becomes the hub's **residency configuration version** (a sensitive domain: changing it later needs a second person) and seeds the egress policy: by default no non-public data class may leave the residency country, and nothing non-public goes to any external model provider until the operator allows it explicitly ([egress](providers-and-models.md#egress-policy)).

### 7. Providers (`providers`)

Every capability starts on its **fake** adapter so the whole hub can be explored without accounts or costs. The step lists capabilities (models, e-mail, SMS, payments, maps, registers, e-signature, tax) and offers, for each, "keep fake for now", "manual" (where a person does the work, for example register look-ups) or "connect later in the console". Live connections are not made in the wizard on purpose: they need a second person (the frozen A+2 action `providers.enable_non_fake`, which has no single-person exception), a passing synthetic test and an egress decision ([providers](providers-and-models.md)). A live e-mail connection may be **prepared and tested** here, and the second staff member enables it later. Until then the first administrator invites the second staff member with a one-time **invitation link** shown on screen and delivered by their own means; the link expires in 72 hours and requires the invitee to set a second factor. The link is the proof of possession for this one invitation; the invitee's e-mail stays "unverified" (shown on the staff list) until e-mail is live, and the invitee's first act can be to approve enabling the e-mail connection.

### 8. Modes (`modes`)

Defaults the operator can change in the console at any time:

| Mode | Default | Choices |
|---|---|---|
| Data | `demo` with synthetic, labelled fixtures, or `live` empty | Demo data never leaves the hub, is never indexed by search engines, never federated, and must be purged (`demo_data_purged` gate) before soft launch |
| Registration | `closed` | `invite_only` from soft launch, `open` only when public (`modesViolations`) |
| Modules | Publications, magazine, events, search, communications on; the rest off with an explanation of what each needs | Dependencies enforced (`MODULE_DEPENDENCIES`) |
| Moderation | `pre_moderate_new_authors` | `pre_moderate_all`, `post_moderate` |
| Automation | Every domain `manual` | `assisted`; `supervised_autonomous` needs a second person and active spending caps |

### 9. Review (`review`)

A summary of every answer with edit links, then **Finish setup**. Finishing records the configuration versions, creates the launch gates (all `open` except those proved during setup), invalidates the setup token, and opens the hub overview with the launch checklist and a short "next five things" list: invite a second staff member, record legal documents with counsel, register the first source, choose a verification recipe, schedule a backup and run a restore drill.

## Adding more hubs later

The node console's **Hubs → Create hub** runs steps 3, 4, 6 and 8 for a new hub on the same node (for example a Texas hub next to the US hub, or a Samarkand city hub next to an Uzbekistan country hub). Territories may overlap; nobody owns a city ([Hubs](../hubs.md#territories)).

## Accessibility and language

The wizard uses the `Stepper` component with a visible step list, one heading per step, errors summarised at the top and linked to fields, and focus moved to the step heading on navigation. It is fully usable on a phone. The wizard's own language is chosen on its first screen from the engine locales and is independent of the hub languages chosen in step 3.

## Acceptance (when implemented)

- Setup cannot start without a valid token and cannot run twice.
- A restricted country, region or place is refused at every level.
- The first administrator cannot finish without a second factor.
- After finishing, the hub is `draft`, registration `closed`, providers fake, indexing off, and every unproved gate `open`.
- One person cannot approve their own second-person request in reduced mode.
