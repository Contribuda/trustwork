import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { blue, color, motion, renderTokensCss, scrim, shadow, type, zIndex, breakpoint } from '../../tokens/index';

const here = dirname(fileURLToPath(import.meta.url));

function luminance(hex: string): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Composites `fg` at `alpha` over `bg` (both hex) and returns the resulting hex colour. */
export function composite(fg: string, alpha: number, bg: string): string {
  const f = parseInt(fg.slice(1), 16);
  const b = parseInt(bg.slice(1), 16);
  const mix = (shift: number) => Math.round(alpha * ((f >> shift) & 255) + (1 - alpha) * ((b >> shift) & 255));
  return `#${[16, 8, 0].map((s) => mix(s).toString(16).padStart(2, '0')).join('')}`;
}

test('tokens.css is generated from tokens/index.ts and committed in sync', () => {
  const committed = readFileSync(join(here, '../../tokens/tokens.css'), 'utf8');
  assert.equal(committed, renderTokensCss(), 'run `npm run tokens:build -w @trustwork/ui` and commit the result');
});

test('z-index scale follows content < sticky < assistant < panel < dialog < toast', () => {
  assert.ok(zIndex.content < zIndex.sticky && zIndex.sticky < zIndex.assistant && zIndex.assistant < zIndex.panel && zIndex.panel < zIndex.dialog && zIndex.dialog < zIndex.toast);
  assert.deepEqual([zIndex.content, zIndex.sticky, zIndex.assistant, zIndex.panel, zIndex.dialog, zIndex.toast], [0, 10, 20, 30, 40, 50]);
});

test('breakpoints are mobile < 768, tablet 768-1279, desktop >= 1280', () => {
  assert.equal(breakpoint.tablet, 768);
  assert.equal(breakpoint.desktop, 1280);
});

test('brand blues are preserved in the tonal scale', () => {
  assert.equal(blue[500], '#1a6ee8', 'logo mark blue');
  assert.equal(blue[600], '#0756d8', 'UI accent blue');
  assert.equal(color.accent, blue[600]);
  assert.equal(color.brandBlue, blue[500]);
  assert.equal(color.navy, blue[900]);
  const lums = Object.values(blue).map(luminance);
  for (let i = 1; i < lums.length; i++) assert.ok((lums[i] ?? 0) < (lums[i - 1] ?? 0), `blue scale must darken monotonically at step ${i}`);
});

test('text colours reach WCAG AA contrast on their backgrounds', () => {
  const pairs: Array<[string, string, number]> = [
    [color.text, color.surface, 4.5],
    [color.text, color.canvas, 4.5],
    [color.text, color.surfaceTint, 4.5],
    [color.text, color.surfaceWarm, 4.5],
    [color.textMuted, color.surface, 4.5],
    [color.textMuted, color.canvas, 4.5],
    [color.textMuted, color.surfaceWarm, 4.5],
    [color.textSubtle, color.surface, 4.5],
    [color.accent, color.surface, 4.5],
    [color.accent, color.canvas, 4.5],
    [color.accent, color.surfaceTint, 4.5],
    [color.textOnAccent, color.accent, 4.5],
    [color.textOnStrong, color.accentStrong, 4.5],
    // Dark navy bands: light text, muted meta and the blue link hover.
    [color.navyText, color.navy, 4.5],
    [color.navyTextMuted, color.navy, 4.5],
    [color.navyLinkHover, color.navy, 4.5],
    [color.navyText, color.navyRaised, 4.5],
    [color.navyTextMuted, color.navyRaised, 4.5],
    // Status families on their tints and on white.
    [color.infoText, color.infoBg, 4.5],
    [color.successText, color.successBg, 4.5],
    [color.warningText, color.warningBg, 4.5],
    [color.dangerText, color.dangerBg, 4.5],
    [color.neutralText, color.neutralBg, 4.5],
    [color.assistantText, color.assistantBg, 4.5],
    [color.infoText, color.surface, 4.5],
    [color.successText, color.surface, 4.5],
    [color.warningText, color.surface, 4.5],
    [color.dangerText, color.surface, 4.5],
    [color.assistantText, color.surface, 4.5],
    // Non-text: focus ring, control boundaries and status marks/rules >= 3:1 (WCAG 1.4.11).
    [color.focus, color.surface, 3],
    [color.focus, color.canvas, 3],
    [color.focus, color.surfaceTint, 3],
    [color.borderStrong, color.surface, 3],
    [color.infoStrong, color.surface, 3],
    [color.successStrong, color.surface, 3],
    [color.warningStrong, color.surface, 3],
    [color.dangerStrong, color.surface, 3],
    [color.assistantStrong, color.surface, 3],
    [color.neutralStrong, color.surface, 3],
  ];
  for (const [fg, bg, min] of pairs) {
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= min, `${fg} on ${bg} = ${ratio.toFixed(2)}:1, expected >= ${min}:1`);
  }
});

test('white text over the scrim keeps AA contrast even above a pure white photograph', () => {
  // Worst case: the brightest possible image under the text zone of the scrim.
  const worst = composite(scrim.solid, scrim.textAlpha, '#ffffff');
  const ratio = contrast('#ffffff', worst);
  assert.ok(ratio >= 4.5, `white on scrim(${scrim.textAlpha}) over white = ${ratio.toFixed(2)}:1`);
  // The muted meta colour used over scrims must also pass.
  assert.ok(contrast(color.navyTextMuted, worst) >= 4.5);
  // The gradient strings must reach at least textAlpha in their text zone.
  for (const gradient of [scrim.bottom, scrim.left, scrim.full, scrim.text]) {
    const alphas = [...gradient.matchAll(/rgba\(15, 31, 61, ([0-9.]+)\)/g)].map((m) => Number(m[1]));
    assert.ok(Math.max(...alphas) >= scrim.textAlpha, `${gradient} never reaches alpha ${scrim.textAlpha}`);
  }
});

test('type scale is descending with tight tracking only on display sizes', () => {
  const rem = (v: string) => parseFloat(v);
  assert.ok(rem(type.display.size) > rem(type.h1.size) && rem(type.h1.size) > rem(type.h2.size) && rem(type.h2.size) > rem(type.h3.size) && rem(type.h3.size) > rem(type.h4.size));
  assert.equal(type.display.tracking, '-0.02em');
  assert.equal(type.h1.tracking, '-0.015em');
  assert.equal(type.body.tracking, '0');
  assert.equal(type.kicker.tracking, '0.08em');
  assert.ok(rem(type.caption.size) >= 0.75, 'never below 12 px');
  assert.ok(parseFloat(type.body.line) >= 1.5, 'body line-height >= 1.5 (WCAG 1.4.12)');
});

test('elevation and motion tokens exist and reduced motion zeroes every duration', () => {
  assert.deepEqual([shadow.e1, shadow.e2, shadow.e3], ['0 1px 2px rgba(16, 24, 40, 0.06)', '0 4px 12px rgba(16, 24, 40, 0.08)', '0 12px 32px rgba(16, 24, 40, 0.12)']);
  assert.equal(motion.enter, '240ms');
  assert.equal(motion.stagger, '40ms');
  const css = renderTokensCss();
  const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
  for (const key of ['fast', 'base', 'slow', 'enter', 'hover', 'open', 'exit', 'stagger']) assert.ok(reduced.includes(`--motion-${key}: 0ms;`), `${key} not zeroed`);
});
