# Terms of use — section template: Sanctions and export controls

Status: template (INTL-SAN, 2026-10-29). Mirrors the "Sanctions and export controls" section of the hosting platform's terms of use (read 2026-10-29). The operator inserts this section into their terms unchanged in substance; wording may be adapted to the deployment's language through the locale files. The owner of the reference deployment is a US person, so the restrictions follow US sanctions and export-control law regardless of where the deployment is hosted.

---

## {N}. Sanctions and export controls

**{N}.1 Restricted places.** The service is not available to anyone located in, ordinarily resident in, or organised under the laws of a restricted place. Restricted places are: Russia; the Crimea, Sevastopol, Donetsk and Luhansk regions of Ukraine; Cuba; Iran; North Korea; and any other country or region that becomes subject to comprehensive United States sanctions. Restricted places never appear in the country selector, and the operator does not build, host, support or hand over anything for a person or company located there.

**{N}.2 Sanctioned parties.** You may not use the service if you, or an organisation you act for, appear on a United States sanctions or export-restriction list (including the OFAC Specially Designated Nationals list and the lists in the Consolidated Screening List), are 50% or more owned or controlled, directly or indirectly, by one or more listed persons, or act for a blocked government.

**{N}.3 No transit, resale or indirect use.** You may not make the service, your account, any access credential or agent key, or any work or data delivered through the service available to a person in a restricted place or to a sanctioned party, whether directly or through intermediaries, affiliates, resellers, subcontractors or customers.

**{N}.4 No circumvention.** You may not use a VPN, proxy, relay or any other technique to disguise your location or identity in order to reach the service from a restricted place or as a sanctioned party.

**{N}.5 Organisations.** If you use the service on behalf of an organisation, you confirm that the organisation and everyone acting for it comply with this section. A company representative signs the partner ownership declaration at onboarding: country of organisation, countries and regions of operation, and whether any listed person or blocked government owns or controls 50% or more of the company.

**{N}.6 Continuing representation.** By using the service you represent that the statements in this section are true and will remain true. If any of them stops being true, you must stop using the service immediately and notify {operator contact}.

**{N}.7 Screening and enforcement.** The operator determines your location from your network address and other signals and may screen accounts, companies, payments and payouts against sanctions and export-restriction lists at any time. The operator may refuse, pause or close access, hold or decline payments, block property where the law requires, and report to the authorities where the law requires, without liability to you. A screening that has not run is shown as "pending", never as "clear".

**{N}.8 Appeals.** If your access was paused because the service believes you are in a restricted place and you are not, contact {operator contact} with evidence of your location; the operator reviews such requests within {review period}.

---

## Operator notes (remove from the published terms)

- `{N}` is the section number in the operator's terms; keep the clauses together and in this order.
- `{operator contact}` is the compliance contact of the deployment; `{review period}` is the committed review time (the reference deployment uses 10 working days).
- The restricted-places list in `packages/country-packs/packs/restricted.json` and `RESTRICTED_PLACES` in `packages/compliance` must match this clause; a change in one is a change in all three.
- Screening uses the US Consolidated Screening List adapter in `packages/compliance`; the operator provisions the API key. Without a key the platform shows "screening pending" and routes the partner to manual review.
- This template does not claim compliance with the local law of the deployment country (ADR-009); counsel adds the local sections.
