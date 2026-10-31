import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';

export type StoryEntry = { id: string; title: string; name: string; type: 'story' | 'docs' };

/** Reads the static Storybook index (dist/storybook/index.json). */
export function loadStories(): StoryEntry[] {
  const index = JSON.parse(readFileSync(resolve('dist/storybook/index.json'), 'utf8')) as { entries: Record<string, StoryEntry> };
  return Object.values(index.entries).filter((entry) => entry.type === 'story');
}

/** Opens a story in the iframe and waits for it to render; fails on uncaught page errors. */
export async function openStory(page: Page, id: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/iframe.html?id=${encodeURIComponent(id)}&viewMode=story`);
  await page.locator('#storybook-root > *').first().waitFor({ state: 'attached', timeout: 20_000 });
  await page.waitForLoadState('networkidle');
  // Let open/close animations (<= 200 ms) settle before scanning.
  await page.waitForTimeout(300);
  return errors;
}

export const axeTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
