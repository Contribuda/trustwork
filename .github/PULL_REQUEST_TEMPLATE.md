<!-- The "PR description" check (scripts/claims.mjs pr) reads this description. Replace every <placeholder>. -->

## What changed

## Why

Work package: `<ID>` · issue #<number>
<!-- Not a work package (for example a new country pack or hub configuration)? Write "Work package: none" and link the issue that agreed the change. -->

## How it was verified

- [ ] `npm run check` at the head commit `<sha>`: <summary line, exit code and test counts>
- [ ] Focused tests for the changed area (commands and exit codes)
- [ ] Browser tests if UI changed; screenshots for visual changes (desktop and phone, at least one non-English language)
- [ ] Locale files updated in every language; English reference complete; no hard-coded brand
- [ ] Negative authorization tests for any new read, write, export, search hit or notification
- [ ] Country facts cite their sources and state how far they are verified
- [ ] No real users, companies, verifications, reviews or traffic faked; demo data labelled synthetic
- [ ] `docs/engine/status.md` and the chapter's status line updated if what is live changed

## Made with an AI agent?

<!-- Tick exactly one. With an agent, fill in the Agent line; without one, leave it as it is. -->
- [ ] No: no AI agent wrote any part of this change
- [ ] Yes: the accountable human reviewed every change and signs off below

Agent: <tool and model> for <human handle>

## Open questions / follow-ups

## Sign-off

- [ ] Every commit carries `Signed-off-by` of the accountable human (DCO)
