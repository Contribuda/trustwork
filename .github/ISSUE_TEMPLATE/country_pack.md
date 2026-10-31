---
name: Add or update a country pack
about: Propose a new country or a correction to an existing pack
labels: country-pack
---

Follow `docs/country-packs/how-to-add-a-country.md`.

**Country** (ISO 3166-1 alpha-2)

**Languages** (BCP 47 tags; which one is the default)

**Currency** (ISO 4217, minor units)

**Company registration identifier** (name, format, validation rule) — with source

**Legal entity types** — with source

**Regions** (ISO 3166-2 codes and native names) — with source

**Data residency / legal notes** that an operator must know

**Checklist**
- [ ] The country is not a restricted place (ADR-009)
- [ ] `node --import tsx scripts/validate-country-packs.ts` passes
- [ ] Dictionaries added or marked partial
