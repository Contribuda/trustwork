# Design reference inventory

Eleven generated PNGs were inspected and preserved byte-for-byte in the private design archive (not part of the engine export); its manifest records source basename/conversation, screen ID, SHA-256, status and functional corrections. Status is derived from the human discussion handoff, not guessed from image quality. Synthetic people/company/project/traffic content is illustrative and not operational evidence or licensed production photography.

| Screen | Status | Main correction or next step |
|---|---|---|
| Public home | Accepted direction/menu | Exact current navigation and truthful source/traction text |
| Companies hub | Accepted direction | Sourced/claimed/verified distinctions; no invented verified customers |
| People hub | Reviewed; proceeded next | Consent/portrait/license/publication rules |
| Projects hub | Reviewed; proceeded next | Only explicitly permitted public projection |
| Weekly magazine | Accepted direction | Mobile reader and separate PDF layout still missing |
| News | Content pattern only | Replace old header with all seven accepted public sections |
| Classic login | Accepted direction | Password/recovery plus Apple/Google; accessible form states |
| Signup | Accepted direction | One name field; do not require surname despite screenshot label |
| Capabilities onboarding | Accepted multi-select direction | Skip; preferences not permission grants |
| Procurement onboarding | Accepted optional categories/regions | No forced company/INN setup |
| Workspace latest | **New proposal, unapproved** | Human feedback; both workflows, full states and responsive refinement |

## Brand and layout rules

Three blue squares in an L-like arrangement with a black stacked wordmark: Trustwork is the product name everywhere; a Russian-language wordmark defined in `apps/web/brand` is shown only in the Russian interface. Raster references inspire a canonical editable asset; no final logo asset is fabricated here. Light white/cool-gray surfaces, restrained blue, readable sans-serif and purposeful imagery. Preserve complete functionality while reducing clutter. No generic giant charts, excessive panels, inconsistent controls or hard-coded product text.

Full-page desktop references guide hierarchy. Mobile adaptation is mandatory in implementation but need not be displayed beside every desktop concept. Public raster references have narrow long-page dimensions and must not be mistaken for measured CSS breakpoints or sufficient typography specs. All pixel values/tokens are provisional until DS-001 review.

## Missing designs and task coverage

| Missing surface | Task | Required deliverables |
|---|---|---|
| Canonical vector logo, type/spacing/colors, component primitives | DS-001 | Editable asset provenance, independent tokens, contrast and keyboard states; Orbit deferred |
| Personal/company detail and permissions | WEB-001 / BE-001 | Public vs private views, no company selector, profile/work separation |
| RFQ intake, comparison, quote versions, mixed bundles | COM-001 / WEB-002 | Complete buyer/seller journeys, mobile tables, uncertainty and approvals |
| Assistant page/overlay, mandates, stop/revoke/unknown outcome | AST-001 / WEB-002 | Same assistant, floating overlay, focus/return, structured status |
| Project plan/execution/change/acceptance/dispute | EXE-001 | Personal/company owners, baseline vs changed plan, evidence visibility |
| Settings/billing/platform administration | BILL-001 | Contextual entrypoints, scoped admin roles, price acceptance |
| Magazine mobile/PDF/archive/corrections | CNT-001 | Curated issue reader and separately rendered PDF |
| Empty/loading/error/forbidden/offline/accessibility/mobile | QA-001 plus each UI task | Screen contract and real-device/keyboard checks |

## Rejection ledger

Do not revive: dark skyscraper logo; English product screenshots; OTP primary auth; multi-company/workspace/personal-company switchers; separate buyer/seller personas; role-focus beside overview; generic inbox/email clone; bottom-left account block; top-right avatar name/chevron; collapse in a separate header cell; docked assistant that shrinks content; “Agents” management UI; primary menu-setup button; automatic sidebar reshuffling; old settled journal paywall; buyers-always-free/suppliers-one-month-free pricing claims. Rejected binaries are intentionally not copied.
