# Administrative shell (DS-005)

Status: implementation in progress, pending conductor acceptance. This is a shared presentation composition, not the ADM-UX-001 application migration or a live console. ADR 019 records only the existing-stack technical acceptance in issue #504, comment 6555259864. Owner visual, native-language and manual assistive-technology acceptance are unperformed.

`AdminShell` composes the existing `Brand`, `AvatarButton`, `Menu`, `Dialog` and DS-003 `CommandPalette`. `AdminContextNavigation` is also exported for contextual placement. The header is an internal composition, not a replacement primitive. The allocated baseline has `ConsoleHeader` in the application, but no existing exported `AdminHeader`; the application remains untouched. `DetailDrawer` stays the existing non-modal inspection primitive and is not used as a mobile modal, which would leave the background interactive.

## Consumer contract

- Supply one already projected `scope`, one account, at most one company name, and at most one assistant destination. Scope is text, never a persona, participant/company or header-level switcher. Do not put private data in these props without its existing projection/grant.
- Supply `navigation` grouped by context, `currentPage` with a stable route id/title, and optional parent `breadcrumbs`. Labels, accessibility text and unavailable reasons must come from the owning locale dictionary. Missing sections show the localized empty state. An unavailable item is explanatory text, not a link to a bypass.
- `onNavigate(destination)` handles ordinary same-tab link activation. The owning router supplies the new current page after successful navigation. Real hrefs retain browser modified-click/new-tab behavior; destinations therefore require the same authorization on direct entry. Use approved routes, including the deployment base path. Never treat an enabled link or callback as authority.
- `palette` supplies query, query callback, permitted command results and loading state. The shell does not search data, filter permissions or resolve text into operations. Command callbacks open the owning destination/form. Required mandates, confirmations, budgets, step-up and case grants remain in their existing application/API paths. Chat text never authorizes anything.
- Account actions are caller callbacks. Missing callbacks render disabled with a visible explanation. Caller actions own errors, pending state and persistence evidence; the shell never reports a saved result. Supply a route change id for account actions that navigate.
- `onLocaleChange` belongs to the app's locale provider/router. All seven options appear in order: en, es, ru, uz-Latn, ka, hy, az-Latn. The shell does not persist preferences. Brand comes exclusively from the registered brand module. The Storybook host supplies the existing Russian deployment overlay.
- `children` belongs inside the shell's one `main` landmark and below its `h1`; do not add another main/header shell or assistant. `notice` is an optional contextual band. Synthetic hosts must supply the synthetic notice; a live consumer must not claim demo data is real.

## Focus and responsive behavior

Below 768 px the contextual navigation moves to the existing modal Dialog. Its open state survives resizing, preserving focus instead of unmounting the focused control. When closed, moving from the desktop navigation to phone layout moves focus to the stable menu trigger. Desktop navigation uses normal links; current location uses `aria-current="page"`. The first Tab reaches the skip link. Breadcrumbs collapse to a labelled parent/back link on phones.

Escape restores the invoking control through React Aria. A committed `currentPage.id` change closes shell overlays and focuses the page heading after overlay restoration. Selecting the current route simply closes the sheet and restores the trigger. Menus, navigation and commands are distinct; Ctrl/Cmd+K does not stack another palette over a shell menu or existing dialog. There are no single-key shortcuts. Reduced motion follows the existing base stylesheet.

Long labels wrap. The page scrolls normally; only open overlay bodies/menus scroll locally, with accessible labels and a visible navigation scroll hint. Import the existing tokens, fonts and base stylesheet once, as other design-system consumers do.

## Preservation and evidence

The six merged prototype journeys and original inventories remain unchanged. Shared navigation translations in `adminShell` are copied from their console dictionaries; the remaining composition copy is a draft in each of the seven UI dictionaries. The stories demonstrate only local navigation and honest unavailable actions, not reconstructed domain journeys.

Focused commands, run from the repository root unless stated otherwise:

```sh
node --import tsx --test packages/ui/tests/unit/admin-shell/locales.test.ts
npm run typecheck -w @trustwork/ui
npx eslint packages/ui/src/components/AdminShell packages/ui/stories/admin-shell packages/ui/tests/unit/admin-shell packages/ui/tests/e2e/admin-shell.spec.ts packages/ui/src/index.ts
npm run validate:docs
npm run build:storybook -w @trustwork/ui
cd packages/ui
STORYBOOK_PORT=6115 npx playwright test admin-shell.spec.ts --project=desktop --workers=1
```

The registered browser suite creates isolated 375/1280 contexts for all seven languages; its project name is desktop but its matrix includes phone widths. It checks rendered landmarks, current location, real Tab/Enter/Escape paths, modal focus containment and return, app callbacks, disabled/empty/long-label states, locale selection, no whole-document overflow, axe, runtime errors and blocked external requests. Screenshots and SHA256 sidecars go to `dist/admin-shell` or the explicit `DS005_EVIDENCE_DIR`. A screenshot is marked visually inspected only in the final manifest after actual agent inspection. This is Chromium automation, not native screen-reader, native-speaker, physical-device or full WCAG acceptance.
