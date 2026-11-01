# DS-003 rendered component evidence

Source/test commit: `a367f034408793e9d49ffd595e76e514fa2a7e80`. These are actual local Storybook screenshots of explicitly synthetic controls, not application acceptance or real activity.

The final focused gate passed **40 browser tests** (33 DS-003 + 7 primitive regressions) and **31 UI unit tests**. The nine stories run in seven languages at 375, 768 and 1280 px, including opened-state axe and keyboard interactions. No page errors, external browser requests or page-level overflow were observed. Axe is not human screen-reader or native-language acceptance.

| Composition | Phone, Russian | Desktop, Russian |
|---|---|---|
| Records, filters, views and selection | [375 px](records-ru-375.png) | [1280 px](records-ru-1280.png) |
| Staff scope and permission matrix | [375 px](access-ru-375.png) | [1280 px](access-ru-1280.png) |
| Diff, approval, reason and step-up | [375 px](decisions-ru-375.png) | [1280 px](decisions-ru-1280.png) |
| Audit, runs, agenda, metric/table and map/list | [375 px](activity-ru-375.png) | [1280 px](activity-ru-1280.png) |

The Russian phone/desktop evidence was visually inspected: wrapped control labels, readable diff columns with explicit horizontal scrolling, matching controlled reason counters, visible keyboard focus and paired accessible data views. The map outline is schematic; its directory is the primary accessible view.

See [manifest.json](manifest.json) for SHA-256 hashes, dimensions, source revision, command and counts, [browser-summary.txt](browser-summary.txt) and [unit-summary.txt](unit-summary.txt) for final output (one unit-test title normalized to English), and [the complete result report](../../../../tools/DS003-result.md) for criteria, boundaries, historical CI and follow-ups.
