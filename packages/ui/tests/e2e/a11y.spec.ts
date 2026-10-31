import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { axeTags, loadStories, openStory } from './stories';

const stories = loadStories();
const results: Array<{ id: string; violations: number; rules: string[] }> = [];

test.describe('axe-core over every story (WCAG 2.0/2.1/2.2 A+AA tags)', () => {
  for (const story of stories) {
    test(`${story.title} / ${story.name}`, async ({ page }) => {
      const errors = await openStory(page, story.id);
      expect(errors, 'no uncaught page errors while rendering').toEqual([]);
      const axe = await new AxeBuilder({ page }).withTags(axeTags).analyze();
      results.push({ id: story.id, violations: axe.violations.length, rules: axe.violations.map((v) => v.id) });
      const summary = axe.violations.map((v) => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`).join('\n');
      expect(axe.violations, summary).toEqual([]);
    });
  }
});

test.afterAll(({}, testInfo) => {
  // One file per worker; tests/axe-summary.mjs merges them into dist/axe-summary.json.
  mkdirSync('dist/axe', { recursive: true });
  writeFileSync(`dist/axe/worker-${testInfo.workerIndex}.json`, JSON.stringify(results, null, 2));
});

test('every exported component has at least one story', () => {
  const titles = new Set(stories.map((s) => `${s.title}/${s.name}`.toLowerCase()));
  const expected = [
    'brand/logo', 'primitives/button', 'primitives/link', 'forms/textfield', 'forms/select', 'forms/checkbox', 'forms/form helpers', 'forms/tagselect',
    'overlays/dialog', 'overlays/popover', 'overlays/toast', 'navigation/tabs', 'navigation/breadcrumb', 'primitives/badge', 'primitives/avatar',
    'primitives/skeleton', 'data/datatable', 'data/comparisontable', 'retrieval/citations', 'shell/workspace shell', 'shell/public shell', 'shell/authshell',
    'shell/assistant launcher and overlay',
    'primitives/typography', 'media/covers and photographs', 'editorial/hero, cards, bands', 'workspace/decision, entity, events', 'showcase/compositions',
  ];
  for (const prefix of expected) {
    expect([...titles].some((title) => title.startsWith(prefix)), `missing stories for ${prefix}`).toBe(true);
  }
});
