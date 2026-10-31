# The weekly magazine

Normative requirements: [News, articles, magazine and the editorial office](modules/publishing-and-editorial.md). Participants: [who uses what](participants/README.md).

Requirements R17, R18. Status: issues, covers, reader, archive, rubric pages and RSS are **Demo**; issues, editions, corrections, render records and local digests are **Live** as an API (CNT-001; the reading pages still use demo data); the PDF layout pipeline is **Designed**; cross-hub digests are **Proposed**; the personalized journal is an **open opportunity**.

A news feed tells you what happened. A magazine tells you what mattered. Every hub can publish a numbered weekly issue, curated by its editors, that people read on a phone in a minute or download as a properly laid-out PDF for the weekend.

## What an issue is

- A **number** and a **date**, a theme, a cover, an editor's letter.
- An ordered list of **items**, each pinned to an exact **publication version** and placed in a rubric section (analysis, practice, overview, experience, interview, project story) or a service section (news of the week, numbers of the week, questions and answers, corrections).
- **Released** issues are frozen: the order and the versions never change. A correction to an article produces a new **issue revision** that references the corrected version and shows a banner; the archive keeps the edition identity.

```text
draft → curated → review → released → corrected edition (new revision)
```

## Reading (Demo)

| Surface | What it does |
|---|---|
| Magazine home | Latest issue cover with the hub's brand lockup (Trustwork, or the hub's registered overlay), set in the reader's script, contents, previous issues |
| Issue page | Hero, editor's letter, contents by section, materials count |
| Reader (`/magazine/:issue/read`) | Page-by-page reading; desktop may show spreads, mobile is a single readable column |
| Archive | Issues by year and month |
| Rubric pages | Every article of one rubric across issues |
| Feed | `/magazine/feed.xml` |

Covers use generated artworks from the engine; a deployment can register its own licensed photographs. The cover typography follows the reader's script; the brand name stays Trustwork unless the hub registers its own overlay.

## The PDF (Designed)

The PDF is a **separate artifact with its own layout**, not a print of the web page. A render job takes a released issue revision and produces a file with a recorded hash and the source revision it came from. Re-rendering after a correction produces a new artifact; both remain traceable. Editors and operations staff can inspect render jobs and retry failed ones.

## Cross-hub digests (Proposed)

Within the [mesh](federation.md), an editor may build a **digest** that selects items from other hubs' released issues (for example "Facade practice across the Americas, November"). Each item stays pinned to its home node, version and licence; the digest only references. Items whose licence does not permit redisplay outside their hub are offered as headline plus link.

## The personalized journal (open)

R18 records an opportunity: a personal intelligence journal about markets, competitors, materials and technologies. Its audience, permitted sources, cadence, sample policy and billing are **unresolved** (O02). The earlier idea "one free issue, then paywall" was rejected. Nothing is built until the owner decides the policy, and it will never monitor employees.

## Invariants

- A released issue never changes; corrections are new revisions with a visible note.
- Web reader and PDF share content provenance and record which revision they render.
- No issue claims readership numbers that were not measured.
