# Legal templates

Templates an operator adapts for their own deployment of the engine (ADR-009). They are starting points, not legal advice: the operator's counsel reviews them for the country of the deployment and the operator's own jurisdiction. Placeholders are in `{braces}`. Each country pack points at the templates it ships with (`legal.templates` in `packages/country-packs/packs/<code>.json`).

| File | Purpose |
|---|---|
| `terms-sanctions-and-export-controls.md` | The sanctions and export-controls section of the terms of use. Mirrors the sanctions section of the hosting platform's terms of use so that the hosted preview and any deployment carry the same restrictions. Required in every deployment's terms. |

| `privacy-location-and-sanctions.md` | Unapproved counsel draft for location and screening data, appeal evidence, disclosure limits and conditional dataset attribution. |

Pending: full terms of use, privacy policy and the partner ownership declaration text (the data contract is `packages/compliance`).
