# Security policy

## Reporting a vulnerability

Report privately through GitHub: open the **Security** tab of `Contribuddha/trustwork` and choose **Report a vulnerability** (private vulnerability reporting, the primary channel). You can also e-mail security@contribuddha.com. Do not open a public issue for vulnerabilities. You will get an acknowledgement within 5 working days and a decision on severity and timeline within 15 working days. Coordinated disclosure: we ask for 90 days before publication, less if a fix ships earlier.

In scope: this repository (engine code, country packs, contracts, design system) and deployments operated by Contribuddha. Out of scope: third-party services, denial-of-service testing, social engineering, anything on infrastructure you do not own.

## What we care about most

- Authorization bypass across companies or projects; public projections leaking private fields.
- Delegation and mandate ceilings (agent authority) being exceeded.
- Sanctions screening being bypassed or faked as "clear".
- Secrets in the repository (`.gitleaks.toml` configures the secret scan run in CI).

## Supported versions

The engine is pre-release; only the `main` branch receives fixes.
