# Terms of use — section template: Sanctions and export controls

Status: **Counsel draft, not approved or activated** (INTL-SAN; SANC-007 clarification). The operator and counsel must review the wording, applicable law, actual configuration and all placeholders before publication. No legal opinion, approval, deadline or provider setup is supplied by this template.

---

## {N}. Sanctions and export controls

**{N}.1 Restricted places.** The service is not available to anyone located in, ordinarily resident in, or organised under the laws of a restricted place. Restricted places are: Russia; the Crimea, Sevastopol, Donetsk and Luhansk regions of Ukraine; Cuba; Iran; North Korea; and any other country or region that becomes subject to comprehensive United States sanctions. Restricted places never appear in the country selector, and the operator does not build, host, support or hand over anything for a person or company located there.

**{N}.2 Sanctioned parties.** You may not use the service if you, or an organisation you act for, appear on a United States sanctions or export-restriction list (including the OFAC Specially Designated Nationals list and the lists in the Consolidated Screening List), are 50% or more owned or controlled, directly or indirectly, by one or more listed persons, or act for a blocked government.

**{N}.3 No transit, resale or indirect use.** You may not make the service, your account, any access credential or agent key, or any work or data delivered through the service available to a person in a restricted place or to a sanctioned party, whether directly or through intermediaries, affiliates, resellers, subcontractors or customers.

**{N}.4 No circumvention.** You may not use a VPN, proxy, relay or any other technique to disguise your location or identity in order to reach the service from a restricted place or as a sanctioned party.

**{N}.5 Organisations.** If you use the service on behalf of an organisation, you confirm that the organisation and everyone acting for it comply with this section. A company representative signs the partner ownership declaration at onboarding: country of organisation, countries and regions of operation, and whether any listed person or blocked government owns or controls 50% or more of the company.

**{N}.6 Continuing representation.** By using the service you represent that the statements in this section are true and will remain true. If any of them stops being true, you must stop using the service immediately and notify {operator contact}.

**{N}.7 Screening and enforcement.** The operator determines your location from your network address and other signals and may screen accounts, companies, payments and payouts against sanctions and export-restriction lists at any time. The operator may refuse, pause or close access, hold or decline payments, block property where the law requires, and report to the authorities where the law requires, without liability to you. A screening that has not run is shown as "pending", never as "clear".

**{N}.8 Appeals.** If your access was paused because the service believes you are in a restricted place and you are not, contact {operator contact} with evidence of your location; the operator reviews the request under its published review process. Where account access is permitted, an eligible screening decision may be appealed through Account Compliance after a fresh identity check. The appeal is recorded with its explanation and evidence and routed for independent review. The decider of the appealed decision cannot decide the appeal; reversal requires a second person. Submission does not mean assignment, reversal or restored access. Notices disclose only what the applicable law permits and never identify another person or a source entry. If no authoritative disclosure policy is available, only a generic contact notice is shown.

---

## Operator notes (remove from the published terms)

- `{N}` is the section number in the operator's terms; keep the clauses together and in this order.
- `{operator contact}` is the verified compliance contact of the deployment. Do not invent a review period; insert one only from an approved operator policy.
- The restricted-places list in `packages/country-packs/packs/restricted.json` and `RESTRICTED_PLACES` in `packages/compliance` must match this clause; a change in one is a change in all three.
- The engine uses configured baseline and additional screening sources. An optional adapter without its required credentials never establishes a clear result. Describe only the adapters actually enabled by the operator; this draft authorizes no provider account, credentials or external calls.
- This template does not claim compliance with the local law of the deployment country (ADR-009); counsel adds the local sections.

See the companion [privacy notice draft](privacy-location-and-sanctions.md) for location data, restricted disclosure, retained evidence and conditional dataset attribution. Neither draft changes the restricted-places list or supplies a counsel approval.
