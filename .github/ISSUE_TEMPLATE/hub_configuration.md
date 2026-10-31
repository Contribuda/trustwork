---
name: Run or configure a hub for your country or city
about: Introduce a hub you want to run, or propose hub configuration (languages, currency, registers, policies) for a territory
labels: area:hubs
---

Read `docs/engine/hubs.md` and `docs/engine/hub-administration.md` first. Country facts (identifiers, regions, legal forms, registers, tax, signatures, payments, holidays) belong in a country pack: use the "Add or update a country pack" template for those.

**Territory** (country ISO 3166-1 alpha-2, and the region or city if the hub is local)

**Who runs it** (organisation or person, and the accountable contact's GitHub handle)

**Languages and currency** (BCP 47 tags, ISO 4217)

**Configuration you need** (modules, registers to check, verification recipes, payment methods, legal notices) and what the engine lacks for it today

**Local law the operator must follow** (personal data, consumer, procurement, e-signature, content) with sources

**Checklist**
- [ ] The territory is not a restricted place (`NOTICE`, ADR-009)
- [ ] No real personal or company data in this issue
- [ ] I understand the operator is responsible for local legal compliance (`docs/engine/hubs.md`)
