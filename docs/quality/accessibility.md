# Accessibility and responsive acceptance

Target **WCAG 2.2 AA**; this is a target, not a conformance claim. The reference images cannot establish accessibility.

Each UI task supplies semantic structure, accessible names, keyboard navigation, visible focus, focus not obscured, status announcements, clear errors and recovery, contrast, zoom/reflow and reduced-motion behavior. Aim at least 24 CSS px minimum targets under applicable WCAG exceptions; prefer larger comfortable controls. Never use color alone for quote status/reputation. Icon-only avatar, collapse and assistant launcher need Russian accessible names.

Assistant overlay must trap focus only when actually modal, support Escape/close, restore focus to launcher, and not cover the focused control unnoticed. Nonmodal overlay must maintain logical keyboard access. It overlays the page without reflow. Collapsed navigation preserves labels/tooltips and keyboard order. Password fields permit password managers/paste; accessible auth cannot depend on memory puzzles. Onboarding is multi-select with clear state and skip.

Test at 320 CSS px width, 200% text zoom/400% browser zoom as applicable, desktop keyboard only, reduced motion, and at least one screen reader (VoiceOver or NVDA). Quote tables need accessible headers and a usable small-screen comparison. Magazine mobile reader is readable single-column; PDF has separately checked pagination, reading order, text and accessibility plan.

Combine automated accessibility checks with manual task walkthroughs. Record browser/device, screen, steps, evidence, remaining issues and reviewer. Do not label automated zero violations as complete accessibility acceptance. Missing screen states are in the design inventory.

Sources: [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [focus not obscured](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum).
