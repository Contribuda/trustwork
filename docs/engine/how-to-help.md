# How to help

Normative requirements: [Open-source governance and contribution](modules/open-source-governance.md). Participants: [who uses what](participants/README.md).

Trustwork gets better every time someone who knows something shares it. You do not need to be a programmer, and you do not need permission to start: pick what matches what you know, and open an issue or a pull request. Everything is reviewed kindly and carefully.

## If you write code

- Run `npm run work` and pick a package whose dependencies are done. Each package names the chapter to read, the paths it owns and how it will be accepted.
- Start small if you are new: tests for existing contracts, accessibility fixes, documentation examples, bugs.
- Big areas waiting for people right now: commerce (COM-001), billing (BILL-001), publications and the magazine (CNT-001), retrieval (RAG-201), administration data (DATA-002), identity hardening (BE-002) and the federation protocol (FED-000).
- Read [Architecture for contributors](architecture.md) and the [agent onboarding guide](agent-onboarding.md), which works for humans too.

## If you speak one of our languages

The interface and demo content exist in English, Russian, Uzbek, Georgian, Armenian and Azerbaijani. The last four are machine drafts by the integrator and **need native speakers**. Spanish is next, then Portuguese, French, German, Italian, Polish, Ukrainian, Turkish, Arabic, Chinese, Hindi and Japanese ([language roadmap](localization.md#languages-and-countries)); each needs translators and, above all, reviewers. Every locale shows honestly whether it is a machine draft, community reviewed or native reviewed. Read the dictionaries in `apps/web/app/_lib/locales/` and `packages/ui/locales/`, fix what sounds wrong, and tell us which construction terms professionals in your country actually use. Want your language? See [Countries and languages](localization.md#adding-a-language).

## If you know a country

Country packs make the engine correct for a country: registration identifiers, regions, legal entity types, registers, licensing, building codes, tax and e-invoicing, electronic signatures, payments, holidays. Every fact needs a source. Start with [How to add a country](../country-packs/how-to-add-a-country.md) and [Country specifics](country-specifics.md); even one well-sourced facet helps every hub in that country. Planned packs (the United States, Canada, Mexico, Brazil, the United Kingdom, the EU layer with Germany, France, Spain, Italy and Poland, Ukraine, Türkiye, the United Arab Emirates, India and Australia) list the facets to source in their work packages; any other country is welcome too.

## If you are a lawyer

Hubs need good templates: terms of use, privacy notices, organizer terms, author terms, and country notes on electronic agreements, reviews and defamation, data residency and consumer protection. Templates live in `docs/legal/templates/`; they are starting points that each operator's counsel adapts, and your review makes them better starting points.

## If you work in construction

You are the reason this exists.

- **Tell us what hurts.** Open an issue describing a real situation: a dispute over hidden works, a quote you could not compare, a subcontractor you could not find. Concrete stories shape the design more than any opinion.
- **Review the designs** of the chapters for your field: [buying and selling](commerce.md), [execution and reputation](execution-and-reputation.md), [partners and matching](partners-and-matching.md), [events](events.md).
- **Write or teach.** When hubs launch, they will need authors, experts and course writers.

## If you design

Screen contracts, accessibility reviews, the magazine's PDF layout, the hub console, the event check-in page on a phone in bright sunlight. The design system lives in `packages/ui`; its documentation is in `docs/design/system/`.

## If you want to run a hub

Read [Hubs](hubs.md) and [Hub administration](hub-administration.md), then open an issue introducing yourself, your territory and your plans. Early operators help shape the console and the launch checklist, and we will help you federate with neighbouring hubs from day one.

## If you are an AI agent, or you run one

Welcome. Start with `AGENTS.md` and the [agent onboarding guide](agent-onboarding.md). Claim work in the open, identify yourself, follow the rules, and hand back evidence. Your human signs off and stays accountable.

## If you want to work with Contribuddha

Trustwork is created and maintained by [Contribuddha](https://contribuddha.com). If you want help launching a hub, adapting the engine for your organisation, or joining the team, get in touch at [contribuddha.com](https://contribuddha.com). Contribuddha does not provide services to persons in the places listed in `NOTICE`.

## How we work together

- **Kindness and precision.** We review the work, not the person. See `CODE_OF_CONDUCT.md`.
- **Decisions in the open.** Issues, pull requests and ADRs; nothing decided in private channels.
- **Honesty over hype.** We say what works and what does not. We never fake users, data or results.
- **Sign-off.** Every commit carries a Developer Certificate of Origin sign-off (`git commit -s`); there is no contributor licence agreement. See `CONTRIBUTING.md`.
- **Sanctions.** Contributions from people located in restricted places are not accepted while the policy is pending counsel (see `GOVERNANCE.md`).

Thank you. Every fixed translation, every sourced fact, every honest story from a site makes construction a little better somewhere.
