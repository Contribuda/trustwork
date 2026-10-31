import type { GlossaryEntry, IssuePoll, IssueView, RubricKey } from '@/app/_lib/data/types';
import { cover, issueCover, storyCover } from '@/app/_lib/media';
import { longDate } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import { rubricLabel } from './rubric';

export type LeafMedia = { src: string; srcSet: string | null; alt: string; dark: boolean };
export type LeafSection = { heading: string; text: string };

/** One piece prepared for the printed layout: parsed body (sections, quote, bullets) and two photographs. */
export type LeafItem = {
  position: number;
  rubric: RubricKey;
  rubricLabel: string;
  title: string;
  lede: string;
  author: string;
  readMinutes: number | null;
  photo: LeafMedia;
  photo2: LeafMedia;
  intro: string[];
  sections: LeafSection[];
  paragraphs: string[];
  quote: string | null;
  bullets: string[];
  quizCount: number;
  readerHref: string;
};

/** One printed page; everything is serialisable so the client leaf only animates. */
export type LeafPage =
  | { no: number; kind: 'cover'; number: number; dateRange: string; title: string; lede: string; rubrics: string[]; highlights: string[]; media: LeafMedia }
  | { no: number; kind: 'contents'; number: number; title: string; lede: string; entries: Array<{ position: number; title: string; rubric: string; page: number; photo: LeafMedia; author: string }> }
  | { no: number; kind: 'item'; side: 'left' | 'right'; item: LeafItem }
  | { no: number; kind: 'colophon'; number: number; dateRange: string; edition: number; releasedAt: string; itemsCount: number; readMinutes: number; authors: string[]; corrections: string[]; glossary: GlossaryEntry[] }
  | { no: number; kind: 'back'; number: number; rubrics: string[]; poll: IssuePoll | null; nextDate: string };

function mediaOf(ref: ReturnType<typeof issueCover>): LeafMedia {
  return { src: ref.src, srcSet: ref.type === 'photo' ? ref.srcSet : null, alt: ref.alt, dark: ref.tone === 'dark' };
}

/** Markdown-lite body → intro paragraphs, `## ` sections with their text, the first quote and the bullet list. */
function parseBody(body: string): Pick<LeafItem, 'intro' | 'sections' | 'paragraphs' | 'quote' | 'bullets'> {
  const blocks = body
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const intro: string[] = [];
  const sections: LeafSection[] = [];
  const paragraphs: string[] = [];
  const bullets: string[] = [];
  let quote: string | null = null;
  for (const block of blocks) {
    if (block.startsWith('## ')) {
      sections.push({ heading: typo(block.slice(3)), text: '' });
      continue;
    }
    if (block.startsWith('> ')) {
      quote ??= typo(block.replace(/^> ?/gm, ''));
      continue;
    }
    if (block.split('\n').every((line) => line.startsWith('- '))) {
      bullets.push(...block.split('\n').map((line) => typo(line.slice(2))));
      continue;
    }
    const text = typo(block);
    paragraphs.push(text);
    const last = sections[sections.length - 1];
    if (last) last.text = last.text ? `${last.text} ${text}` : text;
    else intro.push(text);
  }
  return { intro, sections, paragraphs, quote, bullets };
}

/** Cover, contents, an opener and a text page per piece, the colophon and the back cover: `4 + 2n` pages. */
export function buildLeafPages(issue: IssueView): LeafPage[] {
  const pages: LeafPage[] = [];
  const dateRange = `${longDate(issue.dateFrom)} — ${longDate(issue.dateTo)}`;
  const items: LeafItem[] = issue.items.map((item) => ({
    position: item.position,
    rubric: item.rubric,
    rubricLabel: rubricLabel(item.rubric),
    title: typo(item.title),
    lede: typo(item.lede),
    author: item.authorLabel,
    readMinutes: item.readMinutes,
    photo: mediaOf(storyCover({ id: item.publicationId, slug: item.slug, format: 'article' })),
    photo2: mediaOf(cover('article', `${item.slug}-detail`)),
    ...parseBody(item.body),
    quizCount: item.quiz.length,
    readerHref: `${issue.readerHref}#item-${item.position}`,
  }));
  pages.push({
    no: 1,
    kind: 'cover',
    number: issue.number,
    dateRange,
    title: typo(issue.title),
    lede: typo(issue.lede),
    rubrics: issue.rubrics.slice(0, 3).map(rubricLabel),
    highlights: items.slice(0, 3).map((i) => i.title),
    media: mediaOf(issueCover(issue.number)),
  });
  pages.push({
    no: 2,
    kind: 'contents',
    number: issue.number,
    title: typo(issue.title),
    lede: typo(issue.lede),
    entries: items.map((item, i) => ({ position: item.position, title: item.title, rubric: item.rubricLabel, page: 3 + i * 2, photo: item.photo, author: item.author })),
  });
  items.forEach((item, i) => {
    pages.push({ no: 3 + i * 2, kind: 'item', side: 'left', item });
    pages.push({ no: 4 + i * 2, kind: 'item', side: 'right', item });
  });
  const authors = [...new Set(items.map((i) => i.author))];
  pages.push({
    no: pages.length + 1,
    kind: 'colophon',
    number: issue.number,
    dateRange,
    edition: issue.edition,
    releasedAt: longDate(issue.releasedAt),
    itemsCount: issue.itemsCount,
    readMinutes: issue.readMinutes,
    authors,
    corrections: issue.corrections.map((c) => typo(c.summary)),
    glossary: issue.glossary.slice(0, 4),
  });
  pages.push({ no: pages.length + 1, kind: 'back', number: issue.number, rubrics: issue.rubrics.map(rubricLabel), poll: issue.poll, nextDate: longDate(issue.nextReleaseAt) });
  return pages;
}
