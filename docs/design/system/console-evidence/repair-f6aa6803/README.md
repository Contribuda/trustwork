# DS-003 acceptance repair evidence

Source/story/test commit: `f6aa6803915cbf615e3ee9ed298683c141501787`.

The bounded final run passed **49 browser tests** (42 DS-003 and seven existing primitive regressions), with zero failed/skipped tests. UI units: **32 passed**. Ten stories run in all seven languages at 375/768/1280 px, with real keyboard interactions and axe, including multi-control grid cells, edit boundaries and delayed/rejected/unanswered requests. No axe violations, page errors, external browser requests or page-level overflow were observed in the matrix. Human screen-reader and native-language review remain separate.

| Composition | Russian phone | Russian desktop |
|---|---|---|
| Records | [375](records-ru-375.png) | [1280](records-ru-1280.png) |
| Access | [375](access-ru-375.png) | [1280](access-ru-1280.png) |
| Decisions | [375](decisions-ru-375.png), [After reached with keyboard](decisions-after-ru-375.png) | [1280](decisions-ru-1280.png) |
| Activity | [375](activity-ru-375.png) | [1280](activity-ru-1280.png) |

The three new DiffViewer images were visually inspected. Phone values retain whole readable words inside the preserved 32rem table; the labelled region can be scrolled with the keyboard to expose After fully. The desktop image preserves added/removed/changed and equal unchanged values under native headers. Readability was inspected separately from axe and overflow assertions.

[Manifest](manifest.json): hashes, dimensions, source SHA, exact command, statistics and failed/partial history. [Browser output](browser-summary.txt), [unit output](unit-summary.txt), [complete repair report](../../../../../tools/DS003-repair-result.md). [Original evidence](../README.md) remains unchanged and is historical.
