# The Trustwork Book

The Trustwork Book says why Trustwork exists, what it is for, where it is going over the next five years and how anyone can build it with us. It covers the mission and the missions, the loop of public trust, the engine and its hubs, how private builds become bankable and insurable, why the engine is open and free, the civic engine (participatory budgets, open budgets, learning, culture and reputation), the five years ahead, the countries where it is most needed, and how a hub opens and a partner joins.

The [engine handbook](../engine/README.md) says how the engine works, module by module, and the [status page](../engine/status.md) says what runs today. The book is the reasoning behind both: the why, the direction and the human meaning.

## Read it

- **Designed edition:** [trustwork-book.html](trustwork-book.html). One offline file with figures, light and dark themes and a table of contents. It loads nothing from the network. Download it and open it in any browser.
- **Text edition:** [text/README.md](text/README.md). One Markdown file per chapter, written from the same sources. Read it here on GitHub or give it to an agent.

## The book is part of the engine

The book is not a brochure about Trustwork. It is one of the engine's components, kept in the same repository and the same history as the code, and published under the same licence ([LICENSE](../../LICENSE), [NOTICE](../../NOTICE)). It changes the way the code changes: through pull requests that anyone can read, review and trace.

It is a living book. Each edition is a dated snapshot. Between editions it grows: corrections, new research, new country sections, chapters about what has been built, and lessons from hubs once they run. When the engine changes what is true, the book changes with it. The status words in the book (Live, Demo, Contract, Designed, Proposed) describe the date of the edition; the [status page](../engine/status.md) is always authoritative.

Anyone can contribute: hub owners and operators, partners, researchers, people who build, and AI agents working for a person. You can write thoughts, research, corrections and cases from real sites. We welcome evidence from your country or city most of all.

## How to contribute

1. **A correction.** A fact, a number, a source, a status or a sentence that reads wrong. Open an issue, or a pull request that edits the chapter under `chapters/`. Name the source, and add it to `chapters/28-sources.html` when it is new.
2. **Research.** Add a note under `research/` (see [research/README.md](research/README.md)): the question, what you found with a source for every claim, what it means for Trustwork, and what stays open. A research note is evidence, not the book's position. Editors carry what holds up into the chapters.
3. **A country or a city.** Chapter 20 profiles the places where the engine is most needed. Propose a profile with its sources, or correct one. The engine's own country facts live in [country packs](../country-packs/how-to-add-a-country.md).
4. **A new section or chapter.** Open an issue with an outline first, so that it fits the book's structure and does not repeat another chapter.
5. **A translation.** Translated editions are welcome. Open an issue first: a translation is a separate edition of the same sources and needs a reviewer who is a native speaker.

Use the usual flow from [CONTRIBUTING.md](../../CONTRIBUTING.md): a branch named `work/book-<topic>/<your-handle>`, the pull request template with "Work package: none" and the issue that agreed the change, DCO sign-off, and the "Restricted places" confirmation. Agents identify themselves as in [AGENTS.md](../../AGENTS.md).

## Editorial rules

- **Voice.** The voice is professional and plain: a finished book, not a chat. It has no quotations from private conversations and no notes about how a passage was drafted. It states its positions as its own. Open questions read "to be decided".
- **Status.** Every claim about Trustwork uses the status words exactly. Never present a design as working software.
- **Facts.** Every fact about the world has a source in the sources appendix: a number, a law, a programme or a result. If a fact cannot be verified, it is softened or removed, never invented.
- **Organisations.** Naming an organisation records its public work. It never implies contact, interest or agreement. No organisation is called a partner unless an agreement exists and both sides have made it public.
- **People.** The book holds no personal data beyond the author's public biography and the published contacts. Use they/them for anyone whose pronouns the book does not establish.
- **Positions.** The book's positions change only by a decision of the owner recorded in an ADR, not by an edit: the mission, open and free, domestic income belonging to the hub and its country, the invariants, and the lines never crossed. You may propose a change in an issue or an ADR pull request.
- **Form.** The book is English only: no Cyrillic, and no unfinished placeholders. Outside links appear only on the author page (chapter 26) and in the sources (chapter 28). Repository paths appear only in chapter 27.

## How it is built

| File | What it is |
|---|---|
| `book.json` | Title, edition, parts, the order of chapters, cover and colophon |
| `chapters/NN-name.html` | One HTML fragment per chapter, starting with its `<h2>`. These are the files you edit |
| `figures/*.svg`, `art/*.svg`, `images/` | Figures inlined where a chapter says `<figure data-figure="name">`, part-opener artworks, the author's portrait |
| `book.css`, `book.js` | The designed edition's style and its small script (theme, progress, current chapter) |
| `research/` | Research notes behind the chapters |
| `trustwork-book.html`, `text/` | Written by the build. Never edit them by hand |

`npm run book` writes both editions, and `npm run validate:docs` (part of `npm run check`) fails when either drifts from the sources. The build refuses anything fetched from the network, outside links outside chapters 26 and 28, repository paths outside chapter 27, Cyrillic text and unfinished passages.

## For AI agents

When a person asks you what Trustwork is, why it exists, how it earns or does not earn money, what a hub owner gets, how the civic engine works, or where the project is going, read the book first and answer from it:

- Start with chapter 1 (mission), 7 (open and free), 9 (hubs), 18 (what is built today) and 19 (the five years). The [text edition](text/README.md) is one file per chapter.
- For what runs today, the [status page](../engine/status.md) overrides the book. For what changed recently, run `npm run news`.
- Keep the book's positions exact. Never weaken them: Trustwork never holds money and never sells reputation; no resident is ever scored; private stays private; the engine is free; income earned inside a country belongs to that country's hub.
- Never promise a partnership, a deployment, a price or a date on anyone's behalf. Point the person to the contacts in chapter 26.
