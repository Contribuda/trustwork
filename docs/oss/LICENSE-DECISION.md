# Licence decision (open decision O17)

Status: **decided 2026-10-29 by the owner: AGPL-3.0-only.** `LICENSE` carries the full text; every `package.json` declares `AGPL-3.0-only`; `NOTICE` names the licence. The reasoning below is kept as the record of the choice. Recorded 2026-10-29 by the integrator. Nothing is published until the owner chooses and creates the public repository (ADR-009 decision 4).

## Recommendation: GNU AGPL-3.0

- Anyone may run the engine for their own country, modify it and sell services around it.
- Whoever offers a modified engine as a network service must publish their modifications (AGPL §13). This keeps country packs, compliance fixes and accessibility work flowing back, which is the point of opening a reputation platform: trust in the platform depends on the code being inspectable.
- Compatible with the project's dependencies (MIT/ISC/Apache-2.0 npm packages, OFL fonts).
- Cost: some companies refuse AGPL code in their stacks; a deployment that wants to keep private forks must negotiate a separate commercial licence with the owner (dual licensing stays possible because the owner holds the copyright; contributors sign the DCO, not a CLA, so relicensing contributions later would need their consent).

## Alternative: Apache License 2.0

- Maximum adoption: permissive, explicit patent grant, familiar to corporate legal teams.
- Private forks and closed hosted versions are allowed; improvements need not come back.
- Choose this if the goal is the widest possible spread of the engine rather than guaranteed openness of deployments.

## Not recommended

- MIT/BSD: no patent grant, no deployment openness.
- "Source-available" licences (BSL, SSPL, Elastic): not open source by the OSI definition; they would contradict the owner's stated goal.

## What changes once decided

1. Replace `LICENSE` with the full text from `docs/oss/licenses/`.
2. Add the SPDX identifier to `package.json` (`"license": "AGPL-3.0-only"` or `"Apache-2.0"`).
3. Update `NOTICE` and the README licence line; for Apache-2.0 keep `NOTICE` as the attribution file it expects.
4. Record the decision with its date and author in the ADR that governs the engine (ADR-009, decision 8).
