# News, articles and walls

Requirements R15, R16. Status: reading experience, rubrics, topics and RSS feeds are **Demo**; the publication model, lifecycle and corrections are **Contract**; editorial workflow is **Designed**; hub source registry, multilingual editions and comments are **Proposed**.

Content is what brings people back every day. The engine treats it with the discipline of a good newsroom: sources are named, dates are honest, corrections are visible, and authorship is never confused with editing rights.

## One store for everything published

News items, articles, project stories, company announcements and personal posts are all **publications** in one store. A publication has:

- **Format** (`news`, `article`, `post`, `announcement`, …) and, for articles, an **article format** that says how it is written: `analysis`, `practice`, `overview`, `experience`, `interview`, `projectStory`. These are the magazine **rubrics**.
- **Topics** from the hub taxonomy (today: `materials`, `technologies`, `markets`, `regulation`, `projects`, `people`, `events`). Topics are about the subject; formats are about the genre. They are deliberately separate.
- **Entity links** to companies, people, projects and events mentioned in the text.
- **Authorship**: personal, company or editorial, with credits. Assistant-assisted writing is labelled.
- **Editors**: people with the right to edit, independent from authorship credit.
- **Versions**: every published edition is immutable; the current version is a pointer.

### News carries its source and its time

A news item names its **source** (name, link, type such as industry media, press release, official register, own reporting) and keeps two different times: when the event happened and when the item was published. A reader always sees where a fact came from.

### Walls reference, never copy

A personal or company **wall** lists publication versions by reference. When a publication is corrected, every wall and every magazine issue that points to it shows the correction notice. There is no second copy to fall out of date.

## Lifecycle

```text
draft → in_review (when the policy requires it) → scheduled | published → corrected | retracted
```

- **Review** is required for editorial publications and, where the hub policy says so, for company or personal content in certain formats.
- **Scheduling and embargo** let editors publish at a set time.
- **Correction** creates a new version marked `correction_of`, with a reader-visible note saying what changed. The demo already shows this: the first version of a news item gave the wrong date for a standard, and the corrected version says so.
- **Retraction** keeps an explanatory record visible; legal erasure, if required, is a separate privacy process.

## Reading experience (Demo)

- Home page with featured stories, an aggregated topic feed with in-place "load more", upcoming events and magazine teaser.
- News and article lists with rubric and topic filters; detail pages with source, dates, author card, entity links and related items.
- RSS feeds for news (`/news/feed.xml`) and the magazine (`/magazine/feed.xml`).
- Every string, date and number follows the reader's language; demo content exists in six languages.

## Editorial workflow (Designed)

Editors work in the administration surface (see [Hub administration](hub-administration.md#editorial-and-community)):

| Capability | Who |
|---|---|
| Publications board by state, author type, format, topic, assigned editor | editor |
| Review a submitted version, return for revision, approve | editor |
| Schedule, publish, embargo | editor, editor-in-chief |
| Correct with a reader-visible note | editor |
| Retract with an explanatory record | editor-in-chief |
| Hold a personal or company publication pending moderation | moderator (case required) |
| Fix topics and entity links without touching the body | editor |

## Hub sources (Proposed)

A hub's news desk does not start from an empty page. The hub operator registers **sources** in the hub console (see [Hub administration](hub-administration.md#information-sources)):

- **Kind**: RSS or Atom feed, publisher API, official register announcements, public procurement portal notices, standards body announcements, press-release inbox, statistics office releases.
- **Licence and allowed uses**: display a headline and link, display a summary, store the full text, index for search, send to a model provider, syndicate to other hubs. Each is a separate flag, because licences differ.
- **Attribution template** and **takedown contact**.
- **Cadence** and **observed-at semantics** (when the source says something happened versus when we saw it).

Imported items arrive as **drafts in a review queue**, never published automatically. An editor turns them into news items with the source attached, or discards them. An agent may draft a summary for the editor; the editor publishes.

## Multilingual publishing (Proposed)

A hub may serve several languages (a US hub: English and Spanish; a Canadian hub: English and French; an Indian hub: English and Hindi; the Uzbekistan example: Uzbek in Latin script, Russian and English). A publication has an **original language**; translations are **linked editions** with their own versions and translator credit. A machine-assisted translation is a draft labelled as such until a person reviews it. Readers see the edition in their language when it exists and the original otherwise, with a clear "original in Spanish" label and a link. Demo content already follows the reader's language through per-string overrides; real content will use linked editions.

## Community around publications (Proposed)

| Feature | Design notes |
|---|---|
| **Follow** an author, a company, a topic or a region | Shapes the home feed and notifications; never sold to advertisers |
| **Save and reading progress** | Already shown on «Моя страница» in the demo |
| **Comments** | Off by default per hub; when on, signed-in people only, under the hub's community rules, with reports, moderation cases and the same sanction ladder as other content |
| **Expert answers** | A question format where verified practitioners answer; answers are publications with authorship and corrections |
| **Share** | Plain links and Telegram share; no tracking pixels |

## Invariants

- A publication version, once published, never changes; corrections are new versions.
- A wall, an issue and a search result always point to a version, never a copy.
- Authorship credit and editing rights are separate records.
- Imported source items are never published without a person's decision.
- A source licensed only for display is never sent to a model provider or syndicated to another hub.
