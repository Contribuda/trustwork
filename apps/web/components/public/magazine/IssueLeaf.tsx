'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, List, Maximize2, Minimize2 } from 'lucide-react';
import { t } from '@/app/_lib/i18n';
import type { LeafPage as LeafPageModel } from './leaf-pages';
import { LeafPage } from './LeafPage';

const FLIP_MS = 720;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Printed-magazine preview: two facing pages with a 3D page turn (CSS keyframes, reduced-motion aware), a contents
 * menu that jumps to a spread, keyboard arrows, fullscreen and a link into the web reader. Phones show one page at
 * a time without the fold. Pages are prepared on the server (`buildLeafPages`); each rubric has its own layout.
 */
export function IssueLeaf({ pages, number, readerHref }: { pages: LeafPageModel[]; number: number; readerHref: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [spread, setSpread] = useState(0);
  const [single, setSingle] = useState(false);
  const [page, setPage] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [full, setFull] = useState(false);
  const [flip, setFlip] = useState<'next' | 'prev' | null>(null);
  const [menu, setMenu] = useState(false);
  const total = pages.length;
  const spreads = Math.ceil(total / 2);
  const running = t('magazine.leafRunning', { number });

  /* `#page-N` deep links: read on mount, keep in sync while leafing. */
  useEffect(() => {
    const read = () => {
      const match = /^#page-(\d+)$/.exec(window.location.hash);
      const n = match ? Number(match[1]) : NaN;
      if (n >= 1 && n <= total) {
        setPage(n - 1);
        setSpread(Math.floor((n - 1) / 2));
      }
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, [total]);
  const touch = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const rm = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      setSingle(mq.matches);
      setReduced(rm.matches);
    };
    sync();
    mq.addEventListener('change', sync);
    rm.addEventListener('change', sync);
    const onFull = () => setFull(document.fullscreenElement === rootRef.current);
    document.addEventListener('fullscreenchange', onFull);
    return () => {
      mq.removeEventListener('change', sync);
      rm.removeEventListener('change', sync);
      document.removeEventListener('fullscreenchange', onFull);
    };
  }, []);

  const syncHash = (pageNo: number) => {
    if (pageNo > 1) window.history.replaceState(null, '', `#page-${pageNo}`);
    else if (window.location.hash.startsWith('#page-')) window.history.replaceState(null, '', window.location.pathname + window.location.search);
  };
  const go = useCallback(
    (dir: 'next' | 'prev') => {
      if (single) {
        setPage((p) => {
          const next = Math.min(total - 1, Math.max(0, p + (dir === 'next' ? 1 : -1)));
          syncHash(next + 1);
          return next;
        });
        return;
      }
      if (flip) return;
      if (dir === 'next' && spread >= spreads - 1) return;
      if (dir === 'prev' && spread <= 0) return;
      const target = spread + (dir === 'next' ? 1 : -1);
      syncHash(target * 2 + 1);
      if (reduced) {
        setSpread(target);
        return;
      }
      setFlip(dir);
      window.setTimeout(() => {
        setSpread(target);
        setFlip(null);
      }, FLIP_MS);
    },
    [single, flip, spread, spreads, reduced, total],
  );

  const jump = (pageNo: number) => {
    setMenu(false);
    syncHash(pageNo);
    if (single) setPage(pageNo - 1);
    else setSpread(Math.floor((pageNo - 1) / 2));
  };

  const toggleFull = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await rootRef.current?.requestFullscreen();
    } catch {
      /* fullscreen unavailable */
    }
  };

  const left = pages[spread * 2] ?? null;
  const right = pages[spread * 2 + 1] ?? null;
  const nextLeft = pages[spread * 2 + 2] ?? null;
  const nextRight = pages[spread * 2 + 3] ?? null;
  const prevLeft = pages[spread * 2 - 2] ?? null;
  const prevRight = pages[spread * 2 - 1] ?? null;
  const counter = single ? t('magazine.leafPage', { page: pad(page + 1), total: pad(total) }) : t('magazine.leafPages', { from: pad(spread * 2 + 1), to: pad(Math.min(total, spread * 2 + 2)), total: pad(total) });
  const canPrev = single ? page > 0 : spread > 0;
  const canNext = single ? page < total - 1 : spread < spreads - 1;
  const contentsEntries = pages.flatMap((p) => (p.kind === 'contents' ? p.entries : []));
  const lastNo = pages[pages.length - 1]?.no ?? total;

  return (
    <div
      ref={rootRef}
      className={`leaf${full ? ' is-full' : ''}${single ? ' is-single' : ''}`}
      tabIndex={0}
      aria-label={t('magazine.previewLabel')}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          go('next');
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          go('prev');
        } else if (e.key === 'Escape') setMenu(false);
      }}
    >
      <div className="leaf__bar">
        <div className="leaf__menu">
          <button type="button" className="leaf__btn" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <List size={16} strokeWidth={2} aria-hidden="true" />
            {t('magazine.leafContents')}
          </button>
          {menu ? (
            <ol className="leaf__menu-list" role="menu">
              <li>
                <button type="button" role="menuitem" onClick={() => jump(1)}>
                  <span>01</span>
                  {t('magazine.coverAlt')}
                </button>
              </li>
              {contentsEntries.map((e) => (
                <li key={e.position}>
                  <button type="button" role="menuitem" onClick={() => jump(e.page)}>
                    <span>{pad(e.page)}</span>
                    {e.title}
                    <em>{e.rubric}</em>
                  </button>
                </li>
              ))}
              <li>
                <button type="button" role="menuitem" onClick={() => jump(lastNo - 1)}>
                  <span>{pad(lastNo - 1)}</span>
                  {t('magazine.colophon')}
                </button>
              </li>
            </ol>
          ) : null}
        </div>
        <span className="leaf__counter" aria-live="polite">
          {counter}
        </span>
        <div className="leaf__tools">
          <button type="button" className="leaf__btn" onClick={toggleFull} aria-pressed={full}>
            {full ? <Minimize2 size={16} strokeWidth={2} aria-hidden="true" /> : <Maximize2 size={16} strokeWidth={2} aria-hidden="true" />}
            {full ? t('magazine.leafExit') : t('magazine.leafFull')}
          </button>
        </div>
      </div>

      <div
        className="leaf__stage"
        onTouchStart={(e) => {
          const p = e.touches[0];
          touch.current = p ? { x: p.clientX, y: p.clientY } : null;
        }}
        onTouchEnd={(e) => {
          const start = touch.current;
          const p = e.changedTouches[0];
          touch.current = null;
          if (!start || !p) return;
          const dx = p.clientX - start.x;
          const dy = p.clientY - start.y;
          if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) go(dx < 0 ? 'next' : 'prev');
        }}
      >
        <button type="button" className="leaf__arrow leaf__arrow--prev" aria-label={t('magazine.leafPrev')} onClick={() => go('prev')} disabled={!canPrev}>
          <ChevronLeft size={22} strokeWidth={2} aria-hidden="true" />
        </button>
        {single ? (
          <div className="leaf__book leaf__book--single">
            <LeafPage page={pages[page] ?? null} running={running} side="right" />
          </div>
        ) : (
          <div className={`leaf__book${flip ? ` is-flipping-${flip}` : ''}`}>
            <div className="leaf__half leaf__half--left">
              <LeafPage page={flip === 'prev' ? prevLeft : left} running={running} side="left" />
            </div>
            <div className="leaf__half leaf__half--right">
              <LeafPage page={flip === 'next' ? nextRight : right} running={running} side="right" />
            </div>
            {flip === 'next' ? (
              <div className="leaf__sheet leaf__sheet--next" aria-hidden="true">
                <div className="leaf__face leaf__face--front">
                  <LeafPage page={right} running={running} side="right" />
                </div>
                <div className="leaf__face leaf__face--back">
                  <LeafPage page={nextLeft} running={running} side="left" />
                </div>
              </div>
            ) : null}
            {flip === 'prev' ? (
              <div className="leaf__sheet leaf__sheet--prev" aria-hidden="true">
                <div className="leaf__face leaf__face--front">
                  <LeafPage page={left} running={running} side="left" />
                </div>
                <div className="leaf__face leaf__face--back">
                  <LeafPage page={prevRight} running={running} side="right" />
                </div>
              </div>
            ) : null}
            <span className="leaf__spine" aria-hidden="true" />
          </div>
        )}
        <button type="button" className="leaf__arrow leaf__arrow--next" aria-label={t('magazine.leafNext')} onClick={() => go('next')} disabled={!canNext}>
          <ChevronRight size={22} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div className="leaf__foot">
        <button type="button" className="leaf__link" onClick={() => go('prev')} disabled={!canPrev}>
          <ChevronLeft size={16} strokeWidth={2} aria-hidden="true" />
          {t('magazine.leafPrev')}
        </button>
        <a href={readerHref} className="leaf__open">
          {t('magazine.leafOpen')}
          <ArrowUpRight size={16} strokeWidth={2} aria-hidden="true" />
        </a>
        <button type="button" className="leaf__link" onClick={() => go('next')} disabled={!canNext}>
          {t('magazine.leafNext')}
          <ChevronRight size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
