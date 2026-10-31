# Learning and certificates

Requirement R33. Status: courses, reading progress, bookmarks and certificates on "My page" (`me.title`) and the public certificate check (`/certificates/:id`) are **Demo**; authoring, assessments, accreditation and federated verification are **Proposed**.

A practitioner who learns how to accept hidden works properly makes every facade they touch better. Learning is part of raising the quality of construction, and certificates are part of a person's lifelong profile.

## Courses

A course is short, practical and tied to real work: "Hidden-works acceptance on a ventilated facade", "Reading insulation test reports", "Winter concreting". It has:

- **Modules and lessons**: text, images, short videos, checklists, downloadable templates.
- **Practice tasks**: for example "find three mistakes in this acceptance report".
- **Assessment**: a quiz or a practical task with a pass threshold; graded automatically or by a reviewer.
- **Topics** from the hub taxonomy, so courses appear next to related articles and events.
- **Author**: the hub's editorial team, an expert, or a company (a manufacturer teaching how to install its system is welcome, and labelled as such).
- **Language editions**, like publications.
- **Versions**: changing a course creates a new version; certificates name the version they were earned on.

## Progress (Demo)

"My page" → "Learning" shows courses in progress, reading progress on long articles, bookmarks and earned certificates. Progress is private to the learner; employers do not get a dashboard of their employees' learning.

## Certificates

A certificate is a small public record anyone can check:

| Field | Shown publicly |
|---|---|
| Number | Yes; the check page is `/certificates/<number>` |
| Holder | The holder's public card, if their profile is public; otherwise the name they chose to show on the certificate |
| Course and version | Yes |
| Date and, if the holder agrees, score | Yes |
| Issuer | The hub, and the author organisation |
| Status | Valid, expired (if the course sets a validity period), revoked (with a reason category) |
| Accreditation | Only if the hub recorded one (see below) |

A certificate can be **revoked** with a reason (for example the assessment was found to be compromised); the check page then says so. Certificates of attendance come from [events](events.md).

### Honest about what a certificate means

A platform certificate says "this person completed this course and passed its assessment". It is **not** a state qualification or licence. A hub may record an **accreditation** when a recognised professional body or authority accepts the course (for example for continuing professional development points); the record cites its source and validity, and only then does the certificate show it. Country facets list which professions require state-issued qualifications ([Country specifics](country-specifics.md#construction-licensing-and-professional-qualifications)).

## Authoring and money (Proposed)

- Authors write courses in the workspace; the hub's editorial policy decides whether review is required.
- Courses can be free or paid. Paid courses use price versions and the hub payment adapter, like event tickets; revenue sharing with authors is a hub commercial setting.
- A company may sponsor free access for its customers or employees; sponsorship is labelled.

## In the mesh (Proposed)

Certificates are verifiable across nodes: the check page lives on the home node, and the certificate record federates as a signed public envelope, so a profile replica on another hub can show "certificate verified by hub X" with a link. A node never re-issues another node's certificate.

## Invariants

- A certificate names the course version it was earned on and never changes afterwards; revocation is a new status with a reason.
- Learning progress is private; there is no employer view of it.
- No certificate shows an accreditation without a recorded source.
