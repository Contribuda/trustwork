/**
 * Design tokens for Trustwork (single source of truth).
 *
 * `tokens/tokens.css` is generated from this file by `npm run tokens:build -w @trustwork/ui`;
 * a unit test guards that both stay identical. DS-001 promoted the DS-000 proposal to proposed
 * canonical; DS-002 (visual quality pass, 2026-10-27) adds the tonal system, the editorial type scale,
 * elevation and motion tokens described in docs/design/system/art-direction.md. Human visual
 * acceptance (O09) is separate.
 *
 * Only the light theme is defined. Every colour is a role, so a dark theme can be added
 * later as another `[data-theme]` block without touching components.
 */

/** Blue scale: 500 is the brand mark blue, 600 the UI accent, 900 the navy used for dark bands. */
export const blue = {
  50: '#f0f5ff',
  100: '#e6eefc',
  200: '#b7cdf5',
  300: '#8db2ef',
  400: '#5b93f0',
  500: '#1a6ee8',
  600: '#0756d8',
  700: '#0648b4',
  800: '#053c96',
  900: '#0f1f3d',
} as const;

export const color = {
  /** Warm paper canvas (editorial x industrial): photographs of concrete, wood and brick sit on it without a cold cast. */
  canvas: '#f6f5f2',
  surface: '#ffffff',
  surfaceTint: blue[50],
  surfaceMuted: '#f0efec',
  /** Warm sand used for quiet bands and placeholders. */
  surfaceWarm: '#ece9e3',
  text: '#111827',
  textMuted: '#5b6472',
  textSubtle: '#616b7a',
  textOnAccent: '#ffffff',
  textOnStrong: '#ffffff',
  /** Hairline; cards use elevation instead of borders. */
  border: '#e5e8ee',
  borderStrong: '#7a8494',
  accent: blue[600],
  accentHover: blue[700],
  accentActive: blue[800],
  accentTint: blue[100],
  accentStrong: blue[900],
  accentStrongHover: '#16295a',
  accentStrongActive: '#0a1733',
  focus: blue[600],
  overlayBackdrop: 'rgba(15, 31, 61, 0.52)',
  // Dark navy bands (pre-footer, footer, hero overlays): light text, blue link hover.
  navy: blue[900],
  navyRaised: '#16295a',
  navyText: '#ffffff',
  navyTextMuted: '#c3cce0',
  navyBorder: 'rgba(255, 255, 255, 0.14)',
  navyLinkHover: blue[300],
  // Status families: text keeps >= 4.5:1 on its tint; `strong` is for rules, marks and icons (>= 3:1 on surface).
  infoBg: blue[100],
  infoText: '#0a3f9c',
  infoBorder: blue[200],
  infoStrong: blue[600],
  successBg: '#e3f5ea',
  successText: '#14603a',
  successBorder: '#9ad2b0',
  successStrong: '#1f8a4c',
  warningBg: '#fff3d6',
  warningText: '#704200',
  warningBorder: '#f0c56b',
  warningStrong: '#b07d0a',
  dangerBg: '#fde8e8',
  dangerText: '#9e1b1b',
  dangerBorder: '#f0a3a3',
  dangerStrong: '#d12c2c',
  neutralBg: '#eceff4',
  neutralText: '#3e4756',
  neutralBorder: '#c9d2df',
  neutralStrong: '#7a8494',
  assistantBg: '#efe9fb',
  assistantText: '#4c2a9a',
  assistantBorder: '#c9b8ee',
  assistantStrong: '#6d3fd6',
  // Brand (logo) colours; the three squares use brand blue, the wordmark uses brand ink.
  brandBlue: blue[500],
  brandInk: '#0f1627',
} as const;

/**
 * Scrims for white text over photographs. `solid` is the navy they are built from; `textAlpha` is the
 * alpha reached in the zone where text sits (unit test verifies white text >= 4.5:1 even over a pure
 * white photograph composited through that alpha).
 */
export const scrim = {
  solid: blue[900],
  textAlpha: 0.78,
  bottom: 'linear-gradient(180deg, rgba(15, 31, 61, 0) 0%, rgba(15, 31, 61, 0.28) 40%, rgba(15, 31, 61, 0.78) 78%, rgba(15, 31, 61, 0.9) 100%)',
  left: 'linear-gradient(90deg, rgba(15, 31, 61, 0.9) 0%, rgba(15, 31, 61, 0.78) 42%, rgba(15, 31, 61, 0.1) 100%)',
  full: 'linear-gradient(180deg, rgba(15, 31, 61, 0.78) 0%, rgba(15, 31, 61, 0.82) 100%)',
  /** Anchored to the text block itself (fades in over `--scrim-fade`, default 48 px), so AA holds whatever the frame height. */
  text: 'linear-gradient(180deg, rgba(15, 31, 61, 0) 0px, rgba(15, 31, 61, 0.78) var(--scrim-fade, 48px), rgba(15, 31, 61, 0.78) 100%)',
} as const;

export const space = {
  0: '0',
  1: '0.25rem',
  2: '0.5rem',
  3: '0.75rem',
  4: '1rem',
  5: '1.25rem',
  6: '1.5rem',
  8: '2rem',
  10: '2.5rem',
  12: '3rem',
  14: '3.5rem',
  16: '4rem',
  24: '6rem',
} as const;

/** Vertical rhythm between page sections; mobile values apply below the tablet breakpoint. */
export const section = {
  gap: { desktop: '4rem', mobile: '2.5rem' },
  gapLg: { desktop: '6rem', mobile: '3.5rem' },
} as const;

export const font = {
  sans: '"Golos Text", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  serif: '"PT Serif", Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;

export const weight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export type TypeStyle = {
  size: string;
  /** Unitless line-height. */
  line: string;
  mobileSize: string;
  mobileLine: string;
  tracking: string;
  weight: string;
};

/** Editorial type scale (desktop / mobile). Tight tracking on display sizes only. */
export const type = {
  display: { size: '3.5rem', line: '1.05', mobileSize: '2.25rem', mobileLine: '1.08', tracking: '-0.02em', weight: weight.bold },
  h1: { size: '2.5rem', line: '1.1', mobileSize: '1.875rem', mobileLine: '1.15', tracking: '-0.015em', weight: weight.bold },
  h2: { size: '1.75rem', line: '1.2', mobileSize: '1.5rem', mobileLine: '1.25', tracking: '-0.01em', weight: weight.bold },
  h3: { size: '1.375rem', line: '1.25', mobileSize: '1.25rem', mobileLine: '1.3', tracking: '-0.005em', weight: weight.semibold },
  h4: { size: '1.125rem', line: '1.35', mobileSize: '1.125rem', mobileLine: '1.35', tracking: '0', weight: weight.semibold },
  bodyLg: { size: '1.125rem', line: '1.6', mobileSize: '1.0625rem', mobileLine: '1.6', tracking: '0', weight: weight.regular },
  body: { size: '1rem', line: '1.6', mobileSize: '1rem', mobileLine: '1.6', tracking: '0', weight: weight.regular },
  bodySm: { size: '0.875rem', line: '1.5', mobileSize: '0.875rem', mobileLine: '1.5', tracking: '0', weight: weight.regular },
  caption: { size: '0.75rem', line: '1.4', mobileSize: '0.75rem', mobileLine: '1.4', tracking: '0', weight: weight.regular },
  kicker: { size: '0.75rem', line: '1.3', mobileSize: '0.75rem', mobileLine: '1.3', tracking: '0.08em', weight: weight.semibold },
  /** PT Serif for magazine/article bodies and pull quotes. */
  serif: { size: '1.1875rem', line: '1.65', mobileSize: '1.125rem', mobileLine: '1.6', tracking: '0', weight: weight.regular },
  quote: { size: '1.625rem', line: '1.35', mobileSize: '1.375rem', mobileLine: '1.4', tracking: '-0.005em', weight: weight.regular },
} as const satisfies Record<string, TypeStyle>;

export const radius = {
  control: '0.5rem',
  card: '0.75rem',
  media: '1rem',
  pill: '999px',
  circle: '50%',
} as const;

/** Elevation: cards rest on e1, lift to e2 on hover; popovers e2, dialogs and the magazine cover e3. */
export const shadow = {
  e1: '0 1px 2px rgba(16, 24, 40, 0.06)',
  e2: '0 4px 12px rgba(16, 24, 40, 0.08)',
  e3: '0 12px 32px rgba(16, 24, 40, 0.12)',
  popover: '0 4px 12px rgba(16, 24, 40, 0.08), 0 0 0 1px rgba(16, 24, 40, 0.04)',
  overlay: '0 12px 32px rgba(16, 24, 40, 0.12), 0 24px 64px rgba(16, 24, 40, 0.12)',
  cover: '0 24px 48px rgba(16, 24, 40, 0.28), 0 2px 6px rgba(16, 24, 40, 0.18)',
} as const;

/** Stacking order: content < sticky < assistant overlay < panel/drawer < dialog < toast. */
export const zIndex = {
  content: 0,
  sticky: 10,
  assistant: 20,
  panel: 30,
  dialog: 40,
  toast: 50,
} as const;

/** Breakpoints in CSS px. mobile < 768, tablet 768–1279, desktop >= 1280, wide >= 1600. */
export const breakpoint = {
  tablet: 768,
  desktop: 1280,
  wide: 1600,
} as const;

export const mediaQuery = {
  mobile: `(max-width: ${breakpoint.tablet - 0.02}px)`,
  tabletUp: `(min-width: ${breakpoint.tablet}px)`,
  tabletOnly: `(min-width: ${breakpoint.tablet}px) and (max-width: ${breakpoint.desktop - 0.02}px)`,
  desktopUp: `(min-width: ${breakpoint.desktop}px)`,
  wideUp: `(min-width: ${breakpoint.wide}px)`,
  reducedMotion: '(prefers-reduced-motion: reduce)',
} as const;

export const focus = {
  ringWidth: '2px',
  ringOffset: '2px',
  ringColor: color.focus,
} as const;

/**
 * Motion: durations and easings. `enter` is the page/section fade+rise (with `stagger` per item),
 * `hover` the card lift and media scale, `open`/`exit` overlays. All become 0 ms under reduced motion.
 */
export const motion = {
  fast: '120ms',
  base: '160ms',
  slow: '200ms',
  enter: '240ms',
  hover: '300ms',
  open: '200ms',
  exit: '150ms',
  stagger: '40ms',
  easing: 'cubic-bezier(0.2, 0, 0, 1)',
  easingOut: 'cubic-bezier(0, 0, 0.2, 1)',
  easingIn: 'cubic-bezier(0.4, 0, 1, 1)',
  easingSpring: 'cubic-bezier(0.2, 0.9, 0.3, 1.15)',
} as const;

export const size = {
  targetMin: '24px',
  controlSm: '32px',
  control: '40px',
  controlLg: '48px',
  touchTarget: '44px',
  headerHeight: '64px',
  demoBannerHeight: '32px',
  sidebarWidth: '264px',
  sidebarWidthCollapsed: '72px',
  contentMax: '1360px',
  publicMax: '1200px',
  readerMax: '720px',
  formColumn: '480px',
  gutter: '24px',
  gutterMobile: '16px',
  assistantOverlayWidth: '400px',
  assistantOverlayHeight: '640px',
  assistantOverlayWidthTablet: '380px',
  assistantOverlayHeightTablet: '600px',
  launcher: '56px',
  launcherMobile: '48px',
  launcherOffset: '24px',
  launcherOffsetMobile: '16px',
  tableRow: '44px',
  tableRowCompact: '36px',
  iconUi: '20px',
  iconMeta: '16px',
} as const;

export const tokens = { blue, color, scrim, space, section, font, weight, type, radius, shadow, zIndex, breakpoint, mediaQuery, focus, motion, size } as const;
export type Tokens = typeof tokens;

const kebab = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

/** Flat list of CSS custom properties, in the order they appear in tokens.css. */
export function cssVariables(): Array<[name: string, value: string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(blue)) out.push([`--blue-${k}`, v]);
  for (const [k, v] of Object.entries(color)) out.push([`--color-${kebab(k)}`, v]);
  for (const [k, v] of Object.entries(scrim)) if (typeof v === 'string') out.push([`--scrim-${k}`, v]);
  for (const [k, v] of Object.entries(space)) out.push([`--space-${k}`, v]);
  out.push(['--space-unit', space[1]]);
  out.push(['--space-section', section.gap.desktop]);
  out.push(['--space-section-lg', section.gapLg.desktop]);
  for (const [k, v] of Object.entries(font)) out.push([`--font-${k}`, v]);
  for (const [k, v] of Object.entries(weight)) out.push([`--weight-${k}`, v]);
  for (const [k, v] of Object.entries(type)) {
    out.push([`--text-${kebab(k)}-size`, v.size]);
    out.push([`--text-${kebab(k)}-line`, v.line]);
    out.push([`--text-${kebab(k)}-tracking`, v.tracking]);
    out.push([`--text-${kebab(k)}-weight`, v.weight]);
  }
  for (const [k, v] of Object.entries(radius)) out.push([`--radius-${k}`, v]);
  for (const [k, v] of Object.entries(shadow)) out.push([`--shadow-${k}`, v]);
  for (const [k, v] of Object.entries(zIndex)) out.push([`--z-${k}`, String(v)]);
  out.push(['--focus-ring-width', focus.ringWidth]);
  out.push(['--focus-ring-offset', focus.ringOffset]);
  out.push(['--focus-ring-color', focus.ringColor]);
  out.push(['--focus-ring', `${focus.ringWidth} solid ${focus.ringColor}`]);
  for (const [k, v] of Object.entries(motion)) out.push([`--motion-${kebab(k)}`, v]);
  for (const [k, v] of Object.entries(size)) out.push([`--size-${kebab(k)}`, v]);
  return out;
}

/** Renders the canonical tokens.css text. */
export function renderTokensCss(): string {
  const lines: string[] = [];
  lines.push('/* Generated from tokens/index.ts by `npm run tokens:build -w @trustwork/ui`. Do not edit by hand. */');
  lines.push(`/* Breakpoints (CSS px): mobile < ${breakpoint.tablet}, tablet ${breakpoint.tablet}-${breakpoint.desktop - 1}, desktop >= ${breakpoint.desktop}, wide >= ${breakpoint.wide}. */`);
  lines.push(':root,');
  lines.push('[data-theme="light"] {');
  lines.push('  color-scheme: light;');
  for (const [name, value] of cssVariables()) lines.push(`  ${name}: ${value};`);
  lines.push('}');
  lines.push('');
  lines.push(`@media ${mediaQuery.mobile} {`);
  lines.push('  :root,');
  lines.push('  [data-theme="light"] {');
  lines.push(`    --space-section: ${section.gap.mobile};`);
  lines.push(`    --space-section-lg: ${section.gapLg.mobile};`);
  for (const [k, v] of Object.entries(type)) {
    if (v.mobileSize !== v.size || v.mobileLine !== v.line) {
      lines.push(`    --text-${kebab(k)}-size: ${v.mobileSize};`);
      lines.push(`    --text-${kebab(k)}-line: ${v.mobileLine};`);
    }
  }
  lines.push('  }');
  lines.push('}');
  lines.push('');
  lines.push(`@media ${mediaQuery.reducedMotion} {`);
  lines.push('  :root,');
  lines.push('  [data-theme="light"] {');
  for (const k of Object.keys(motion)) if (!k.startsWith('easing')) lines.push(`    --motion-${kebab(k)}: 0ms;`);
  lines.push('  }');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}
