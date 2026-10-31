'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import NextLink from '@/components/locale/LocalLink';
import { ArrowLeft, ArrowRight, ArrowUpRight, Bookmark, BookmarkCheck, Check, ChevronLeft, ChevronRight, Columns2, Link2, List, Minus, Plus, X } from 'lucide-react';
import { Dialog, useIsMobile } from '@trustwork/ui';
import { Prose } from '@/components/ui';
import { PersonAvatar } from './PersonAvatar';
import { PdfButton } from './PdfButton';
import { renderBody } from './body';
import { Quiz } from './magazine/Quiz';
import { RubricChip } from './magazine/rubric';
import { loadIssueState, quizTotals, saveIssueState, type IssueState } from './magazine/reader-state';
import type { IssueView } from '@/app/_lib/data';
import { longDate, t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';

const SIZES = [16, 18, 20, 22] as const;
const THEMES = ['light', 'sepia', 'dark'] as const;
type Theme = (typeof THEMES)[number];
export type ReaderCover = { src: string; srcSet: string | null; alt: string; author: string | null };
export type ReaderAuthor = { name: string; roleLine: string; portrait: string | null; href: string };
export type ReaderRelated = { id: string; href: string; title: string; kicker: string; meta: string };
type IssueLink = { number: number; title: string; href: string } | null;

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Magazine web reader: sticky bar (back, counter, contents, text size, background, two-column spread on desktop,
 * PDF state, close) with a reading-progress line; a sticky contents rail with read marks and the glossary; one
 * serif article at a time (rubric, title, lede, byline, cover, correction banner, body, «Проверь себя» quiz,
 * bookmark, copy link) with keyboard ← → and a «next item» card; the last item ends with the issue summary.
 * Reading state lives only in the browser. The current item lives in `#item-N` so links deep-link into it.
 */
export function Reader({
  issue,
  covers,
  authors,
  related,
  nextDate,
  previousIssue,
  nextIssue,
}: {
  issue: IssueView;
  covers: Record<number, ReaderCover>;
  authors: Record<number, ReaderAuthor | null>;
  related: Record<number, ReaderRelated[]>;
  nextDate: string;
  previousIssue: IssueLink;
  nextIssue: IssueLink;
}) {
  const isMobile = useIsMobile();
  const [sizeIndex, setSizeIndex] = useState(1);
  const [theme, setTheme] = useState<Theme>('light');
  const [spread, setSpread] = useState(false);
  const [tocOpen, setTocOpen] = useState(false);
  const [current, setCurrentState] = useState(1);
  const [progress, setProgress] = useState(0);
  const [state, setState] = useState<IssueState>({ read: [], bookmarks: [], quiz: {}, poll: null });
  const [copied, setCopied] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  const total = issue.items.length;

  const update = useCallback(
    (fn: (s: IssueState) => IssueState) => {
      setState((prev) => {
        const next = fn(prev);
        saveIssueState(issue.number, next, total);
        return next;
      });
    },
    [issue.number, total],
  );
  const markRead = useCallback((position: number) => update((s) => (s.read.includes(position) ? s : { ...s, read: [...s.read, position].sort((a, b) => a - b) })), [update]);

  /* Side effects (read mark, hash, scroll, focus) run outside the state updater: React forbids updates to other
     components (the router patches history.replaceState) from inside an updater function. */
  const currentRef = useRef(1);
  currentRef.current = current;
  const setCurrent = useCallback(
    (next: number | ((c: number) => number)) => {
      const prev = currentRef.current;
      const value = Math.min(total, Math.max(1, typeof next === 'function' ? next(prev) : next));
      if (value === prev) return;
      if (value > prev) markRead(prev);
      setCurrentState(value);
      window.history.replaceState(null, '', `#item-${value}`);
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: 0 });
        articleRef.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
      });
    },
    [total, markRead],
  );

  useEffect(() => {
    const read = () => {
      const match = /^#item-(\d+)$/.exec(window.location.hash);
      const n = match ? Number(match[1]) : NaN;
      if (n >= 1 && n <= total) setCurrentState(n);
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, [total]);

  useEffect(() => {
    const stored = Number(readStorage('trustwork.reader.size'));
    if (SIZES.includes(stored as (typeof SIZES)[number])) setSizeIndex(SIZES.indexOf(stored as (typeof SIZES)[number]));
    const storedTheme = readStorage('trustwork.reader.theme');
    if (THEMES.includes(storedTheme as Theme)) setTheme(storedTheme as Theme);
    setState(loadIssueState(issue.number));
  }, [issue.number]);

  /* Reading progress of the current item; the item counts as read once its end has been reached. */
  useEffect(() => {
    const onScroll = () => {
      const el = articleRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const viewport = window.innerHeight;
      const done = Math.min(1, Math.max(0, (viewport - rect.top) / Math.max(1, rect.height)));
      setProgress(Math.round(done * 100));
      if (done >= 0.98) markRead(current);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [current, markRead]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === 'ArrowRight') setCurrent((c) => c + 1);
      else if (e.key === 'ArrowLeft') setCurrent((c) => c - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setCurrent]);

  useEffect(() => {
    if (!copied) return;
    const handle = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(handle);
  }, [copied]);

  const changeSize = (delta: number) => {
    const next = Math.min(SIZES.length - 1, Math.max(0, sizeIndex + delta));
    setSizeIndex(next);
    writeStorage('trustwork.reader.size', String(SIZES[next]));
  };
  const changeTheme = (next: Theme) => {
    setTheme(next);
    writeStorage('trustwork.reader.theme', next);
  };

  const item = issue.items[current - 1];
  const nextItem = issue.items[current] ?? null;
  const prevItem = issue.items[current - 2] ?? null;
  const useSpread = spread && !isMobile;
  const cover = item ? covers[item.position] : undefined;
  const body = item ? renderBody(item.body) : null;
  const correction = item?.isCorrected ? issue.corrections.find((c) => c.itemTitle === item.title) : undefined;
  const bookmarked = item ? state.bookmarks.includes(item.position) : false;
  const quizStored = item ? (state.quiz[String(item.position)] ?? null) : null;
  const totals = quizTotals(state);
  const readCount = state.read.length;

  const toc = (inDialog: boolean) => (
    <ol className={`mgr__toc${inDialog ? ' mgr__toc--dialog' : ''}`}>
      {issue.items.map((x) => {
        const isRead = state.read.includes(x.position);
        return (
          <li key={x.position}>
            <button
              type="button"
              className={`mgr__toc-btn${isRead ? ' is-read' : ''}`}
              aria-current={x.position === current ? 'true' : undefined}
              onClick={() => {
                setCurrent(x.position);
                setTocOpen(false);
              }}
            >
              <span className="mgr__toc-num">{isRead ? <Check size={14} strokeWidth={2.5} aria-label={t('magazine.readDone')} /> : String(x.position).padStart(2, '0')}</span>
              <span className="mgr__toc-text">
                <span>{typo(x.title)}</span>
                <span className="mgr__toc-meta">
                  <RubricChip rubric={x.rubric} />
                  {x.readMinutes ? <span>{t('magazine.minutesShort', { count: x.readMinutes })}</span> : null}
                  {state.bookmarks.includes(x.position) ? <Bookmark size={12} strokeWidth={2} aria-label={t('magazine.bookmarked')} /> : null}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );

  return (
    <div className={`mgr${useSpread ? ' is-spread' : ''}`} data-theme={theme}>
      <header className="mgr__bar" aria-label={t('reader.label')}>
        <div className="mgr__bar-left">
          <NextLink href={issue.href} className="mgr__back">
            <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
            <span>{t('reader.backToIssue')}</span>
          </NextLink>
          <span className="mgr__issue">
            {t('magazine.issueTitle', { number: issue.number })} · {typo(issue.title)}
          </span>
        </div>
        <div className="mgr__bar-center" aria-live="polite">
          <button type="button" className="mgr__ctl" aria-label={t('reader.back')} onClick={() => setCurrent((c) => c - 1)} disabled={current === 1}>
            <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
          </button>
          <span className="mgr__counter">{t('reader.progress', { index: current, total })}</span>
          <button type="button" className="mgr__ctl" aria-label={t('reader.forward')} onClick={() => setCurrent((c) => c + 1)} disabled={current === total}>
            <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div className="mgr__bar-right">
          <button type="button" className="mgr__ctl mgr__ctl--text mgr__ctl--toc" onClick={() => setTocOpen(true)}>
            <List size={16} strokeWidth={2} aria-hidden="true" />
            <span>{t('reader.contents')}</span>
          </button>
          <div role="group" aria-label={t('reader.fontSize')} className="mgr__group">
            <button type="button" className="mgr__ctl" aria-label={t('reader.fontSmaller')} onClick={() => changeSize(-1)} disabled={sizeIndex === 0}>
              <Minus size={16} strokeWidth={2} aria-hidden="true" />
            </button>
            <span className="mgr__size" aria-hidden="true">
              Аа
            </span>
            <button type="button" className="mgr__ctl" aria-label={t('reader.fontLarger')} onClick={() => changeSize(1)} disabled={sizeIndex === SIZES.length - 1}>
              <Plus size={16} strokeWidth={2} aria-hidden="true" />
            </button>
            <span className="mgr__sr" aria-live="polite">
              {t('reader.fontSizeNow', { size: SIZES[sizeIndex]! })}
            </span>
          </div>
          <div role="group" aria-label={t('magazine.theme')} className="mgr__themes">
            {THEMES.map((th) => (
              <button
                key={th}
                type="button"
                className={`mgr__theme mgr__theme--${th}`}
                aria-label={t(th === 'light' ? 'magazine.themeLight' : th === 'sepia' ? 'magazine.themeSepia' : 'magazine.themeDark')}
                aria-pressed={theme === th}
                onClick={() => changeTheme(th)}
              />
            ))}
          </div>
          {!isMobile ? (
            <button type="button" className="mgr__ctl mgr__ctl--text" onClick={() => setSpread((s) => !s)} aria-pressed={useSpread}>
              <Columns2 size={16} strokeWidth={2} aria-hidden="true" />
              <span>{useSpread ? t('reader.singleColumn') : t('reader.spread')}</span>
            </button>
          ) : null}
          <span className="mgr__pdf">
            <PdfButton pdf={issue.pdf} size="sm" />
          </span>
          <NextLink href={issue.href} className="mgr__ctl" aria-label={t('reader.close')}>
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </NextLink>
        </div>
        <span className="mgr__progress" aria-hidden="true" style={{ width: `${progress}%` }} />
      </header>

      <Dialog title={t('reader.contents')} isOpen={tocOpen} onOpenChange={setTocOpen} size="sm">
        {toc(true)}
      </Dialog>

      <div className="mgr__body">
        <nav aria-label={t('magazine.contents')} className="mgr__rail">
          <div className="mgr__rail-progress">
            <span className="mgr__rail-ring" style={{ ['--p' as string]: `${total ? Math.round((readCount / total) * 100) : 0}%` }} aria-hidden="true" />
            <span>
              <span className="mgr__rail-title">{t('magazine.progressTitle')}</span>
              <span className="mgr__rail-line">{readCount >= total && total > 0 ? t('magazine.progressDone') : t('magazine.progressRead', { read: readCount, total })}</span>
              {totals.total ? <span className="mgr__rail-line">{t('magazine.quizIssueScore', { score: totals.score, total: totals.total })}</span> : null}
            </span>
          </div>
          {toc(false)}
          {issue.glossary.length ? (
            <details className="mgr__gloss">
              <summary>{t('magazine.glossaryTitle')}</summary>
              <dl>
                {issue.glossary.map((g) => (
                  <div key={g.term}>
                    <dt>{typo(g.term)}</dt>
                    <dd>{typo(g.definition)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}
          <p className="mgr__hint">{t('magazine.keyboardHint')}</p>
          <p className="mgr__hint">{t('magazine.progressLocal')}</p>
        </nav>

        {item ? (
          <article key={item.position} ref={articleRef} id={`item-${item.position}`} className="mgr__article" style={{ fontSize: `${SIZES[sizeIndex]}px` }} aria-labelledby="reader-title">
            <header className="mgr__head">
              <p className="mgr__kicker">
                <RubricChip rubric={item.rubric} link size="md" />
                {item.readMinutes ? <span>{t('magazine.readMinutes', { count: item.readMinutes })}</span> : null}
                <span>{t('version.item', { version: item.version })}</span>
                {state.read.includes(item.position) ? (
                  <span className="mgr__readmark">
                    <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                    {t('magazine.readDone')}
                  </span>
                ) : null}
              </p>
              <h1 id="reader-title" tabIndex={-1} className="mgr__title">
                {typo(item.title)}
              </h1>
              <p className="mgr__lede">{typo(item.lede)}</p>
              <div className="mgr__byline-row">
                <p className="mgr__byline">
                  {t('magazine.authorPrefix')}:{' '}
                  {item.authorHref ? (
                    <NextLink href={item.authorHref} className="mgr__author">
                      {item.authorLabel}
                    </NextLink>
                  ) : (
                    <span className="mgr__author">{item.authorLabel}</span>
                  )}
                </p>
                <div className="mgr__tools">
                  <button
                    type="button"
                    className={`mgr__tool${bookmarked ? ' is-on' : ''}`}
                    aria-pressed={bookmarked}
                    onClick={() => update((s) => ({ ...s, bookmarks: bookmarked ? s.bookmarks.filter((p) => p !== item.position) : [...s.bookmarks, item.position] }))}
                  >
                    {bookmarked ? <BookmarkCheck size={15} strokeWidth={2} aria-hidden="true" /> : <Bookmark size={15} strokeWidth={2} aria-hidden="true" />}
                    {bookmarked ? t('magazine.bookmarked') : t('magazine.bookmark')}
                  </button>
                  <button
                    type="button"
                    className="mgr__tool"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(`${window.location.origin}${issue.readerHref}#item-${item.position}`);
                        setCopied(true);
                      } catch {
                        setCopied(false);
                      }
                    }}
                    aria-live="polite"
                  >
                    {copied ? <Check size={15} strokeWidth={2} aria-hidden="true" /> : <Link2 size={15} strokeWidth={2} aria-hidden="true" />}
                    {copied ? t('magazine.shareCopied') : t('magazine.shareCopy')}
                  </button>
                </div>
              </div>
            </header>
            {cover ? (
              <figure className="mgr__cover">
                <img src={cover.src} {...(cover.srcSet ? { srcSet: cover.srcSet, sizes: '(max-width: 767px) 100vw, 920px' } : {})} alt={cover.alt} />
                <figcaption>{cover.alt}</figcaption>
              </figure>
            ) : null}
            {authors[item.position] ? (
              <NextLink href={authors[item.position]!.href} className="mgr__author-card">
                <PersonAvatar name={authors[item.position]!.name} portrait={authors[item.position]!.portrait} size={40} />
                <span>
                  <strong>{authors[item.position]!.name}</strong>
                  <em>{authors[item.position]!.roleLine}</em>
                </span>
              </NextLink>
            ) : null}
            {item.isCorrected ? (
              <div className="mg-banner mgr__banner" role="status">
                <span className="mg-banner__body">
                  {t('common.corrected')}: {correction ? typo(correction.summary) : t('magazine.edition', { edition: issue.edition, date: longDate(issue.releasedAt) })}
                </span>
                <NextLink href={`${issue.href}#corrections`} className="mg-banner__link">
                  {t('magazine.corrections')}
                </NextLink>
              </div>
            ) : null}
            <Prose family="serif" measure="reader" as="div" className="mgr__prose">
              {body?.nodes}
            </Prose>
            {item.mentions.length ? (
              <p className="mgr__mentions">
                <span className="mgr__mentions-label">{t('magazine.mentions')}:</span>
                {item.mentions.map((m) =>
                  m.href ? (
                    <NextLink key={`${m.kind}:${m.label}`} href={m.href} className="mgr__mention">
                      {m.label}
                    </NextLink>
                  ) : (
                    <span key={`${m.kind}:${m.label}`} className="mgr__mention">
                      {m.label}
                    </span>
                  ),
                )}
              </p>
            ) : null}
            {item.quiz.length ? (
              <Quiz
                key={`${issue.number}-${item.position}`}
                questions={item.quiz}
                stored={quizStored}
                onDone={(score, qt) => update((s) => ({ ...s, quiz: { ...s.quiz, [String(item.position)]: { score, total: qt } } }))}
              />
            ) : null}
            {(related[item.position] ?? []).length ? (
              <section className="mgr__related" aria-label={t('magazine.related')}>
                <span className="mgr__related-title">{t('magazine.related')}</span>
                <ul>
                  {(related[item.position] ?? []).map((r) => (
                    <li key={r.id}>
                      <NextLink href={r.href}>
                        <span className="mgr__related-kicker">{r.kicker}</span>
                        <span className="mgr__related-name">{typo(r.title)}</span>
                        <span className="mgr__related-meta">{r.meta}</span>
                      </NextLink>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <footer className="mgr__foot">
              {!state.read.includes(item.position) ? (
                <button type="button" className="mgr__tool mgr__tool--wide" onClick={() => markRead(item.position)}>
                  <Check size={15} strokeWidth={2} aria-hidden="true" />
                  {t('magazine.markRead')}
                </button>
              ) : null}
              <nav aria-label={t('magazine.contents')} className="mgr__pager">
                {prevItem ? (
                  <button type="button" className="mgr__pager-prev" onClick={() => setCurrent((c) => c - 1)}>
                    <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
                    <span>
                      <span className="mgr__pager-label">{t('reader.previous')}</span>
                      <span className="mgr__pager-title">{typo(prevItem.title)}</span>
                    </span>
                  </button>
                ) : (
                  <span />
                )}
                {nextItem ? (
                  <button type="button" className="mgr__next" onClick={() => setCurrent((c) => c + 1)}>
                    <span className="mgr__next-label">{t('reader.next')}</span>
                    <span className="mgr__next-rubric">
                      <RubricChip rubric={nextItem.rubric} />
                      {nextItem.readMinutes ? <span>{t('magazine.minutesShort', { count: nextItem.readMinutes })}</span> : null}
                    </span>
                    <span className="mgr__next-title">{typo(nextItem.title)}</span>
                    <span className="mgr__next-lede">{typo(nextItem.lede)}</span>
                    <span className="mgr__next-cta">
                      {t('reader.next')}
                      <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                    </span>
                  </button>
                ) : (
                  <div className="mgr__done">
                    <span className="mgr__done-title">{t('magazine.finishedTitle', { number: issue.number })}</span>
                    <span className="mgr__done-body">
                      {t('magazine.finishedBody', { date: nextDate })}
                      {totals.total ? ` ${t('magazine.quizIssueScore', { score: totals.score, total: totals.total })}.` : ''}
                    </span>
                    <span className="mgr__done-actions">
                      {previousIssue ? (
                        <NextLink href={previousIssue.href} className="pub-btn pub-btn--dark pub-btn--sm">
                          № {previousIssue.number} · {typo(previousIssue.title)}
                        </NextLink>
                      ) : null}
                      {nextIssue ? (
                        <NextLink href={nextIssue.href} className="pub-btn pub-btn--dark pub-btn--sm">
                          № {nextIssue.number} · {typo(nextIssue.title)}
                        </NextLink>
                      ) : null}
                      <NextLink href="/magazine/archive" className="pub-more">
                        {t('magazine.toArchive')}
                        <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
                      </NextLink>
                    </span>
                  </div>
                )}
              </nav>
            </footer>
          </article>
        ) : null}
      </div>
    </div>
  );
}
