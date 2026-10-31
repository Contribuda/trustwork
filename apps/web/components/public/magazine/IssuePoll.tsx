'use client';

import { useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import type { IssuePoll as PollModel } from '@/app/_lib/data/types';
import { t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import { loadIssueState, saveIssueState } from './reader-state';

/** Poll of the week: the answer stays in the browser; the distribution shown is a labelled synthetic sample. */
export function IssuePoll({ issue, poll, total }: { issue: number; poll: PollModel; total: number }) {
  const [choice, setChoice] = useState<number | null>(null);
  const [voted, setVoted] = useState<number | null>(null);
  useEffect(() => {
    setVoted(loadIssueState(issue).poll);
  }, [issue]);
  const sum = poll.sample.reduce((a, b) => a + b, 0) || 1;
  const vote = () => {
    if (choice === null) return;
    const state = loadIssueState(issue);
    saveIssueState(issue, { ...state, poll: choice }, total);
    setVoted(choice);
  };
  return (
    <section className="mg-poll" aria-labelledby="poll-title">
      <span className="pub-kicker">
        <BarChart3 size={14} strokeWidth={2} aria-hidden="true" /> {t('magazine.pollTitle')}
      </span>
      <h3 className="mg-poll__question" id="poll-title">
        {typo(poll.question)}
      </h3>
      {voted === null ? (
        <>
          <div className="mg-poll__options" role="radiogroup" aria-label={typo(poll.question)}>
            {poll.options.map((o, i) => (
              <button key={o} type="button" role="radio" aria-checked={choice === i} className={`mg-poll__option${choice === i ? ' is-picked' : ''}`} onClick={() => setChoice(i)}>
                {typo(o)}
              </button>
            ))}
          </div>
          <button type="button" className="pub-btn pub-btn--dark pub-btn--sm" disabled={choice === null} onClick={vote}>
            {t('magazine.pollVote')}
          </button>
        </>
      ) : (
        <ul className="mg-poll__results">
          {poll.options.map((o, i) => {
            const pct = Math.round(((poll.sample[i] ?? 0) / sum) * 100);
            return (
              <li key={o} className={voted === i ? 'is-mine' : undefined}>
                <span className="mg-poll__label">{typo(o)}</span>
                <span className="mg-poll__bar" aria-hidden="true">
                  <span style={{ width: `${pct}%` }} />
                </span>
                <span className="mg-poll__pct">{pct}%</span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="mg-poll__note">{voted === null ? t('magazine.pollResults') : `${t('magazine.pollVoted')}. ${t('magazine.pollSample')}`}</p>
    </section>
  );
}
