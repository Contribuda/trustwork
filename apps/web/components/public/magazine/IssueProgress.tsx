'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, Bookmark, CheckCircle2, Flame } from 'lucide-react';
import { t } from '@/app/_lib/i18n';
import { listDoneIssues, loadIssueState, quizTotals, streakFrom } from './reader-state';
import { localHref } from '@/app/_lib/localize';

/** «Ваш прогресс»: items read, quiz answers, bookmarks and the issue streak, read from the browser only. */
export function IssueProgress({ issue, total, readerHref, positions, compact = false }: { issue: number; total: number; readerHref: string; positions: number[]; compact?: boolean }) {
  const [state, setState] = useState<{ read: number[]; bookmarks: number; score: number; quizTotal: number; streak: number } | null>(null);
  useEffect(() => {
    const s = loadIssueState(issue);
    const q = quizTotals(s);
    setState({ read: s.read, bookmarks: s.bookmarks.length, score: q.score, quizTotal: q.total, streak: streakFrom(issue, listDoneIssues()) });
  }, [issue]);
  if (!state) return null;
  const read = state.read.length;
  const pct = total ? Math.round((read / total) * 100) : 0;
  const done = total > 0 && read >= total;
  return (
    <aside className={`mg-progress${compact ? ' mg-progress--compact' : ''}`} aria-label={t('magazine.progressTitle')}>
      <div className="mg-progress__ring" style={{ ['--p' as string]: `${pct}%` }} aria-hidden="true">
        <span>{pct}%</span>
      </div>
      <div className="mg-progress__body">
        <span className="mg-progress__title">{t('magazine.progressTitle')}</span>
        <span className="mg-progress__line">{done ? t('magazine.progressDone') : t('magazine.progressRead', { read, total })}</span>
        <span className="mg-progress__facts">
          {state.quizTotal ? (
            <span>
              <CheckCircle2 size={14} strokeWidth={2} aria-hidden="true" />
              {t('magazine.quizIssueScore', { score: state.score, total: state.quizTotal })}
            </span>
          ) : null}
          {state.bookmarks ? (
            <span>
              <Bookmark size={14} strokeWidth={2} aria-hidden="true" />
              {t('magazine.bookmarksCount', { count: state.bookmarks })}
            </span>
          ) : null}
          {state.streak ? (
            <span>
              <Flame size={14} strokeWidth={2} aria-hidden="true" />
              {t('magazine.streak', { count: state.streak })}
            </span>
          ) : null}
        </span>
        <a href={localHref(done ? readerHref : `${readerHref}#item-${positions.find((p) => !state.read.includes(p)) ?? positions[0] ?? 1}`)} className="mg-progress__cta">
          {read === 0 ? t('magazine.progressStart') : done ? t('magazine.readOnline') : t('magazine.progressContinue')}
          <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
        </a>
        <span className="mg-progress__note">{t('magazine.progressLocal')}</span>
      </div>
    </aside>
  );
}
