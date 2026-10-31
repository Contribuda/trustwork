import { expect, test } from '@playwright/test';
import { openStory } from './stories';

/**
 * Real contrast of white text over photographs under scrims. axe cannot evaluate text over images or gradients
 * (it reports them as "incomplete"), so this test draws the rendered photograph into a canvas with the same
 * object-fit: cover geometry, composites every navy gradient layer between the image and the text (the frame's
 * `::after` scrim and the text-anchored gradient of the overlay block) at every sampled point inside the text's
 * bounding box, and asserts WCAG AA (>= 4.5:1) against white at the worst point. Covers the three scrim variants,
 * the lead/medium heroes, the showcase hero, the magazine cover and the auth panel.
 */
const cases = [
  { story: 'media-covers-and-photographs--scrims-with-text', root: '[data-testid="scrim-bottom"]', text: 'h3' },
  { story: 'media-covers-and-photographs--scrims-with-text', root: '[data-testid="scrim-left"]', text: 'h3' },
  { story: 'media-covers-and-photographs--scrims-with-text', root: '[data-testid="scrim-full"]', text: 'h3' },
  { story: 'editorial-hero-cards-bands--hero-lead', root: 'article', text: 'h1' },
  { story: 'editorial-hero-cards-bands--hero-medium', root: 'article', text: 'h2' },
  { story: 'showcase-compositions--home', root: 'main article:first-of-type', text: 'h1' },
  { story: 'editorial-hero-cards-bands--magazine-covers', root: 'a[href="#issue-12"]', text: 'p' },
  { story: 'shell-authshell--login', root: '[aria-hidden="true"]:has(img)', text: 'p:nth-child(2)' },
];

test.describe('white text over scrims keeps >= 4.5:1 against the real photograph', () => {
  for (const c of cases) {
    test(`${c.story} ${c.root}`, async ({ page }) => {
      await openStory(page, c.story);
      const result = await page.evaluate(
        async ({ root: rootSelector, text }) => {
          const root = document.querySelector(rootSelector);
          if (!root) throw new Error(`root ${rootSelector} not found`);
          const img = root.querySelector('img') as HTMLImageElement | null;
          const frameEl = img?.parentElement as HTMLElement | null;
          const textEl = root.querySelector(text) as HTMLElement | null;
          if (!img || !frameEl || !textEl) throw new Error('image, frame or text element not found');
          await img.decode();
          type Stop = { r: number; g: number; b: number; a: number; at: number; unit: 'px' | '%' };
          type Layer = { angle: number; stops: Stop[]; box: DOMRect };
          const parseGradient = (value: string, box: DOMRect): Layer | null => {
            const m = value.match(/linear-gradient\((?:(\d+)deg, )?(.*)\)$/);
            if (!m) return null;
            const stops = [...(m[2] ?? '').matchAll(/rgba\((\d+), (\d+), (\d+), ([0-9.]+)\) ([0-9.]+)(px|%)/g)].map((s) => ({ r: Number(s[1]), g: Number(s[2]), b: Number(s[3]), a: Number(s[4]), at: Number(s[5]), unit: s[6] as 'px' | '%' }));
            return stops.length ? { angle: m[1] ? Number(m[1]) : 180, stops, box } : null;
          };
          const layers: Layer[] = [];
          const frameBox = frameEl.getBoundingClientRect();
          const after = parseGradient(getComputedStyle(frameEl, '::after').backgroundImage, frameBox);
          if (after) layers.push(after);
          // Any element between the text and the frame that paints its own gradient (the anchored overlay block).
          for (let el: HTMLElement | null = textEl; el && el !== frameEl; el = el.parentElement) {
            const own = parseGradient(getComputedStyle(el).backgroundImage, el.getBoundingClientRect());
            if (own) layers.unshift(own);
          }
          layers.reverse(); // frame scrim first (closest to the image), anchored block last (on top)
          if (!layers.length) throw new Error('no scrim layer found');
          const alphaAt = (layer: Layer, px: number, py: number) => {
            const { angle, stops, box } = layer;
            const length = angle === 90 || angle === 270 ? box.width : box.height;
            const pos = angle === 90 ? px - box.left : angle === 270 ? box.right - px : angle === 0 ? box.bottom - py : py - box.top;
            const at = (s: Stop) => (s.unit === 'px' ? s.at : (s.at / 100) * length);
            const first = stops[0]!;
            const last = stops[stops.length - 1]!;
            if (pos <= at(first)) return first;
            for (let i = 1; i < stops.length; i++) {
              const a = stops[i - 1]!;
              const b = stops[i]!;
              if (pos <= at(b)) {
                const k = (pos - at(a)) / Math.max(at(b) - at(a), 1e-6);
                return { ...a, a: a.a + (b.a - a.a) * k };
              }
            }
            return last;
          };
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(frameBox.width);
          canvas.height = Math.round(frameBox.height);
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('no canvas');
          const scale = Math.max(frameBox.width / img.naturalWidth, frameBox.height / img.naturalHeight);
          const dw = img.naturalWidth * scale;
          const dh = img.naturalHeight * scale;
          ctx.drawImage(img, (frameBox.width - dw) / 2, (frameBox.height - dh) / 2, dw, dh);
          const lum = (r: number, g: number, b: number) => {
            const ch = (v: number) => {
              const c = v / 255;
              return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
          };
          const tr = textEl.getBoundingClientRect();
          let min = Infinity;
          let worst = { x: 0, y: 0 };
          let samples = 0;
          for (let y = Math.max(tr.top, frameBox.top); y < Math.min(tr.bottom, frameBox.bottom); y += 3) {
            for (let x = Math.max(tr.left, frameBox.left); x < Math.min(tr.right, frameBox.right); x += 3) {
              const p = ctx.getImageData(Math.floor(x - frameBox.left), Math.floor(y - frameBox.top), 1, 1).data;
              let [r, g, b] = [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
              for (const layer of layers) {
                const s = alphaAt(layer, x, y);
                r = s.a * s.r + (1 - s.a) * r;
                g = s.a * s.g + (1 - s.a) * g;
                b = s.a * s.b + (1 - s.a) * b;
              }
              const ratio = 1.05 / (lum(r, g, b) + 0.05);
              samples++;
              if (ratio < min) {
                min = ratio;
                worst = { x: Math.round(x - frameBox.left), y: Math.round(y - frameBox.top) };
              }
            }
          }
          return { min, worst, color: getComputedStyle(textEl).color, layers: layers.length, samples };
        },
        c,
      );
      expect(result.color).toBe('rgb(255, 255, 255)');
      expect(result.samples).toBeGreaterThan(50);
      expect(result.min, `min contrast ${result.min.toFixed(2)}:1 at ${JSON.stringify(result.worst)} through ${result.layers} layer(s)`).toBeGreaterThanOrEqual(4.5);
    });
  }
});
