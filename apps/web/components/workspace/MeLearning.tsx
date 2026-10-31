'use client';

import { useEffect, useState } from 'react';
import NextLink from '@/components/locale/LocalLink';
import { ArrowRight, Bookmark, BookOpenCheck, GraduationCap } from 'lucide-react';
import { SRLogo } from '@/components/public/SRMark';
import { loadIssueState, quizTotals } from '@/components/public/magazine/reader-state';
import { t, longDate } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';

export type LearningIssue = { number: number; title: string; readerHref: string; items: Array<{ position: number; title: string }> };
export type LearningCertificate = { id: string; title: string; issuedAt: string; score: number | null; href: string };
export type LearningCourse = { id: string; title: string; modules: number; minutes: number };

/**
 * «Обучение» on my page: reading progress and quiz results per issue and the bookmarks, all read from the
 * browser (the magazine reader stores them there); platform certificates come from the person's record.
 */
export function MeLearning({ issues, certificates, courses, academyHref }: { issues: LearningIssue[]; certificates: LearningCertificate[]; courses: LearningCourse[]; academyHref: string }) {
  const [rows, setRows] = useState<Array<{ issue: LearningIssue; read: number; score: number; total: number; bookmarks: Array<{ position: number; title: string }> }>>([]);
  useEffect(() => {
    setRows(
      issues.map((issue) => {
        const s = loadIssueState(issue.number);
        const q = quizTotals(s);
        return { issue, read: s.read.length, score: q.score, total: q.total, bookmarks: issue.items.filter((i) => s.bookmarks.includes(i.position)) };
      }),
    );
  }, [issues]);
  const started = rows.filter((r) => r.read > 0 || r.total > 0 || r.bookmarks.length > 0);
  const bookmarks = rows.flatMap((r) => r.bookmarks.map((b) => ({ ...b, issue: r.issue })));
  const totals = rows.reduce((a, r) => ({ read: a.read + r.read, score: a.score + r.score, total: a.total + r.total }), { read: 0, score: 0, total: 0 });
  return (
    <div className="ws-grid ws-grid--main">
      <div className="ws-section">
        <ul className="ws-stats">
          <li className="ws-stat">
            <strong>{totals.read}</strong>
            <span>{t('me.learning.readCount')}</span>
          </li>
          <li className="ws-stat">
            <strong>{totals.total ? `${totals.score}/${totals.total}` : '—'}</strong>
            <span>{t('me.learning.quizCount')}</span>
          </li>
          <li className="ws-stat">
            <strong>{bookmarks.length}</strong>
            <span>{t('me.learning.bookmarksCount')}</span>
          </li>
          <li className="ws-stat">
            <strong>{certificates.length}</strong>
            <span>{t('me.learning.certCount')}</span>
          </li>
        </ul>
        <div className="ws-h2-row">
          <h3 className="ws-h2">
            <BookOpenCheck size={18} strokeWidth={2} aria-hidden="true" />
            {t('me.learning.issues')}
          </h3>
          <NextLink href="/magazine" className="ws-more">
            {t('publicNav.7')}
            <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
          </NextLink>
        </div>
        {started.length ? (
          <ul className="ws-progress-list">
            {started.map((r) => {
              const pct = r.issue.items.length ? Math.round((r.read / r.issue.items.length) * 100) : 0;
              return (
                <li key={r.issue.number} className="ws-progress">
                  <span className="ws-ring" style={{ ['--p' as string]: `${pct}%` }} aria-hidden="true">
                    <span>{pct}%</span>
                  </span>
                  <span className="ws-row__main">
                    <NextLink href={r.issue.readerHref} className="ws-row__title">
                      {t('magazine.issueTitle', { number: r.issue.number })} · {typo(r.issue.title)}
                    </NextLink>
                    <span className="ws-row__meta">
                      <span>{t('magazine.progressRead', { read: r.read, total: r.issue.items.length })}</span>
                      {r.total ? <span>{t('magazine.quizIssueScore', { score: r.score, total: r.total })}</span> : null}
                    </span>
                  </span>
                  <NextLink href={r.issue.readerHref} className="ws-row__action">
                    {r.read >= r.issue.items.length ? t('magazine.readOnline') : t('magazine.progressContinue')}
                  </NextLink>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="ws-empty">
            <strong>{t('me.learning.emptyTitle')}</strong>
            <span>{typo(t('me.learning.emptyBody'))}</span>
            <NextLink href="/magazine" className="ws-more">
              {t('magazine.readOnline')}
              <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
            </NextLink>
          </div>
        )}
        <div className="ws-h2-row">
          <h3 className="ws-h2">
            <Bookmark size={18} strokeWidth={2} aria-hidden="true" />
            {t('me.saved')}
          </h3>
        </div>
        {bookmarks.length ? (
          <ul className="ws-list">
            {bookmarks.map((b) => (
              <li key={`${b.issue.number}-${b.position}`} className="ws-row">
                <span className="ws-row__main">
                  <NextLink href={`${b.issue.readerHref}#item-${b.position}`} className="ws-row__title">
                    {typo(b.title)}
                  </NextLink>
                  <span className="ws-row__meta">
                    <span>{t('magazine.issueTitle', { number: b.issue.number })}</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ws-muted">{t('me.learning.bookmarksEmpty')}</p>
        )}
        <p className="ws-note">{t('magazine.progressLocal')}</p>
      </div>
      <div className="ws-section">
        <h3 className="ws-h2">
          <GraduationCap size={18} strokeWidth={2} aria-hidden="true" />
          {t('me.learning.certificates')}
        </h3>
        {certificates.length ? (
          <ul className="ws-list">
            {certificates.map((c) => (
              <li key={c.id} className="ws-cert">
                <span className="ws-cert__tile" aria-hidden="true">
                  <SRLogo size={18} tone="white" />
                </span>
                <span>
                  <strong>{typo(c.title)}</strong>
                  <span>
                    {longDate(c.issuedAt)}
                    {c.score !== null ? ` · ${c.score}%` : ''} · <NextLink href={c.href}>{t('me.learning.check')}</NextLink>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="ws-muted">{t('me.learning.certEmpty')}</p>
        )}
        <h3 className="ws-h2">{t('me.learning.courses')}</h3>
        <ul className="ws-list">
          {courses.map((c) => (
            <li key={c.id} className="ws-row">
              <span className="ws-row__main">
                <span className="ws-row__title">{typo(c.title)}</span>
                <span className="ws-row__meta">
                  <span>{t('magazine.academyModules', { count: c.modules })}</span>
                  <span>{t('magazine.academyMinutes', { count: c.minutes })}</span>
                </span>
              </span>
              <NextLink href={academyHref} className="ws-row__action">
                {t('magazine.academyOpen')}
              </NextLink>
            </li>
          ))}
        </ul>
        <p className="ws-note">{t('me.learning.coursesNote')}</p>
      </div>
    </div>
  );
}
