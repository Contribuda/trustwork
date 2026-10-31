import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Reader, type ReaderAuthor, type ReaderCover, type ReaderRelated } from '@/components/public/Reader';
import { formatLabel } from '@/components/public/parts';
import { storyCover } from '@/app/_lib/media';
import { data } from '@/app/_lib/data';
import { longDate, shortDate, t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

type Params = { params: Promise<{ issue: string }> };

function parseNumber(raw: string): number | null {
  return /^\d{1,6}$/.test(raw) ? Number(raw) : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  await primeLocale();
  const { issue } = await params;
  const number = parseNumber(issue);
  const found = number === null ? null : data.getIssue(number);
  return { title: found ? `${t('reader.label')} — ${t('magazine.issueTitle', { number: found.issue.number })}` : t('error.notFoundTitle') };
}

/** Web reader for a released issue; the item is selected by `#item-N`. Unknown numbers → 404. */
export default async function ReadPage({ params }: Params) {
  await primeLocale();
  const { issue: raw } = await params;
  const number = parseNumber(raw);
  const found = number === null ? null : data.getIssue(number);
  if (!found) notFound();
  const { issue, previous, next } = found;
  const covers: Record<number, ReaderCover> = Object.fromEntries(
    issue.items.map((item) => {
      const media = storyCover({ id: item.publicationId, slug: item.slug, format: 'article' });
      return [item.position, { src: media.src, srcSet: media.type === 'photo' ? media.srcSet : null, alt: media.alt, author: media.type === 'photo' ? media.author : null }];
    }),
  );
  const authors: Record<number, ReaderAuthor | null> = Object.fromEntries(
    issue.items.map((item) => {
      const slug = item.authorKind === 'person' && item.authorHref ? item.authorHref.split('/').pop() : null;
      const person = slug ? data.getPerson(slug) : null;
      return [item.position, person ? { name: person.displayName, roleLine: person.roleLine, portrait: person.portrait, href: person.href } : null];
    }),
  );
  const pool = [...data.listArticles(), ...data.listNews()];
  const inIssue = new Set(issue.items.map((i) => i.publicationId));
  const related: Record<number, ReaderRelated[]> = Object.fromEntries(
    issue.items.map((item) => [
      item.position,
      pool
        .filter((c) => c.id !== item.publicationId && !inIssue.has(c.id) && c.topics.some((tp) => item.topics.includes(tp)))
        .slice(0, 3)
        .map((c) => ({ id: c.id, href: c.href, title: c.title, kicker: formatLabel(c), meta: `${c.authorLabel} · ${shortDate(c.publishedAt)}` })),
    ]),
  );
  return (
    <Reader
      issue={issue}
      covers={covers}
      authors={authors}
      related={related}
      nextDate={longDate(issue.nextReleaseAt)}
      previousIssue={previous ? { number: previous.number, title: previous.title, href: previous.readerHref } : null}
      nextIssue={next ? { number: next.number, title: next.title, href: next.readerHref } : null}
    />
  );
}
