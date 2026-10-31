# My page: private work view and public projection

Route: `/app/me` (private work view), `/app/me/public` (projection editor and preview), public result at `/people/[slug]`.

## Status and evidence

`no reference`. Spec R01 (persistent profile, public page/wall, experience, publications, reputation; contributions survive employment changes), "Identity, company and public pages" (personal public profile and private work view are separate projections even if reachable from one destination), design inventory missing surface "Personal/company detail and permissions — public vs private views, profile/work separation".

## Audience and access policy

Only the person. Two projections:

| Projection | Contents | Who sees |
|---|---|---|
| Private work view (`/app/me`) | Everything about me: interests/preferences, current employment and its status, memberships history (private), my mandates summary, my drafts, my saved items, my activity, my project roles, my personal budget entry points | Me only |
| Public projection (`/app/me/public`) | What I chose to show on `/people/[slug]`: publish on/off, portrait consent, display employer on/off, bio, topics, which publications/projects to list (only those already public), contact enablement | Me edits; the public sees the result |

Employer-derived data is labelled and disappears from the private view's "current" section when membership ends but stays in private history (O04 policy for the company side is separate).

## Data projection

| Section | Fields |
|---|---|
| Header | Avatar (private view may show image regardless of public consent), name (editable), role line, employer chip with membership state (current employer / invitation / ended), "Open the public page" (if published) |
| Interests | Capabilities and categories/regions from onboarding, editable here |
| Work | My open decisions, my projects by role, my RFQs/quotes I am operator on (links), my mandates to the assistant (count + link) |
| Contributions | Publications (all lifecycle states, mine), saved items, comments if any |
| History | Employment memberships with dates (private), transfers of project ownership, accepted terms versions |
| Public projection editor | Published toggle, portrait consent toggle with licence statement, show employer toggle, bio (plain text, limit), topics, publication/project list with per-item "show" checkboxes, contact toggle; "Preview" renders the public component in a dialog with the public projection only |

## Primary tasks

1. See my own work and decisions across companies/projects.
2. Control what is public about me, with consent recorded explicitly.
3. Edit name, interests, avatar.
4. Reach account settings (contextual link; not a nav item).

## Layout regions

| Width | Layout |
|---|---|
| Desktop ≥1280 | Shell; PageHeader (H1 "My page", actions "Public page", "Account settings"); tabs: Work, Publications, Interests, History, Public profile (`me.tabs.*`); Work tab: two-column (decisions + projects left, mandates + saved right); Public profile tab: form left (max 720 px) + live preview card right |
| Tablet | Tabs scroll; single column; preview below form |
| Mobile <768 | Single column; preview via "Preview" button opening full-screen dialog |

## Component inventory

PageHeader, Tabs, Avatar + AvatarUpload (file input with accessible label, crop optional), TextField, Textarea with counter, Switch (with visible on/off text), CheckboxList, ConsentStatement (checkbox with legal text and version), PreviewDialog, ObjectRow, StatusChip (membership), MandateSummary, EmptyState, FormAlert, Toast, Skeleton.

## Interaction states

| State | Behaviour |
|---|---|
| Empty | New user: Work shows onboarding hints ("Start with a project or a publication"); Public profile shows "The page is not published" |
| Loading | Skeleton per tab |
| Error | Save errors inline; FormAlert |
| Permission-denied | Not applicable (own data); employer sections vanish after membership end with explanation row |
| Offline | Edits blocked with toast; reading allowed |
| Partial/stale | Portrait consent withdrawn → public page updates; private view shows "portrait hidden on the public page" |

## Keyboard order and focus

Shell → H1 → header actions → tabs → panel. Public profile form: published switch → consent → employer switch → bio → topics → lists → contact → "Save" → "Preview". Preview dialog traps focus and returns to the button. Save success announced via toast live region and focus stays on the button.

## Responsive table behaviour

History tab table (organization, role, from, to, status) collapses to stacked cards below 768.

## Locale keys

| Key | English |
|---|---|
| `me.title` | My page |
| `me.publicPage` | Public page |
| `me.accountSettings` | Account settings |
| `me.tabs.work` | Work |
| `me.tabs.publications` | Publications |
| `me.tabs.interests` | Interests |
| `me.tabs.history` | History |
| `me.tabs.publicProfile` | Public profile |
| `me.membership.active` | Current workplace |
| `me.membership.invited` | Invitation |
| `me.membership.ended` | Ended {date} |
| `me.mandates` | Mandates for the assistant |
| `me.saved` | Saved |
| `me.startHint` | Start with a project or a publication |
| `me.public.published` | The page is published |
| `me.public.unpublished` | The page is not published |
| `me.public.portraitConsent` | Allow my portrait to be shown on the public page |
| `me.public.portraitLicence` | I confirm that I have the right to use this image. |
| `me.public.showEmployer` | Show my current workplace |
| `me.public.bio` | About me |
| `me.public.topics` | Topics |
| `me.public.show` | Show |
| `me.public.contact` | Allow messages to me through the platform |
| `me.public.preview` | Preview |
| `me.public.previewTitle` | This is how others see your page |
| `me.public.portraitHidden` | The portrait is hidden on the public page |
| `me.history.org` | Organisation |
| `me.history.role` | Role |
| `me.history.from` | Start |
| `me.history.to` | End |
| `common.save` | Save |
| `common.saved` | Saved |
| `common.cancel` | Cancel |

## Open questions

- Whether the public slug is editable (propose: generated, changeable once).
- Contact via platform depends on R08 correspondence model (COM-001); toggle hidden until it exists.
- Which employment-history details the person may see after leaving (O04 covers company history, not own membership record; propose own record always visible).
