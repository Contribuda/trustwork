'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, Sparkles } from 'lucide-react';
import { Button, RunStatusBadge, StatusChip, Tabs, TextArea, VisuallyHidden } from '@trustwork/ui';
import { useAssistant } from './AssistantContext';
import { DateTile } from './ProjectRow';
import type { AssistantView } from '@/app/_lib/data';
import { longDate, t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';

/**
 * `/app/assistant` full page. The conversation tab reads the same context as the floating overlay; the
 * page explains that chat text grants no authority and lists mandates, approvals and runs from fixtures.
 */
export function AssistantPageClient({ view }: { view: AssistantView }) {
  const assistant = useAssistant();
  const [draft, setDraft] = useState('');
  const { unread, markRead } = assistant;
  useEffect(() => {
    if (unread > 0) markRead();
  }, [unread, markRead]);
  const suggestions = [t('assistantPage.suggestion1'), t('assistantPage.suggestion2'), t('assistantPage.suggestion3')];

  const conversation = (
    <div className="ws-grid ws-grid--main">
      <section aria-labelledby="conv-title" className="ws-section">
        <h2 id="conv-title" className="ws-h2">
          <Sparkles size={18} strokeWidth={2} aria-hidden="true" />
          {t('assistantPage.tabs.conversation')}
        </h2>
        <div role="log" aria-live="polite" aria-label={t('assistant.overlay.conversation')} className="ws-chat">
          {assistant.messages.length === 0 ? (
            <div className="ws-msg ws-msg--assistant">
              <span className="ws-msg__who">{t('assistant.messageFromAssistant')}</span>
              <p>{typo(t('assistant.intro'))}</p>
              <span className="ws-head__kicker">{t('assistantPage.suggestedStarts')}</span>
              <div className="ws-suggest">
                {suggestions.map((s) => (
                  <button key={s} type="button" className="ws-chip" onClick={() => setDraft(s)}>
                    {typo(s)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {assistant.messages.map((m) => (
            <div key={m.id} className={`ws-msg ws-msg--${m.role === 'user' ? 'user' : 'assistant'}`}>
              <VisuallyHidden>{m.role === 'user' ? t('assistant.messageFromUser') : t('assistant.messageFromAssistant')}: </VisuallyHidden>
              <span className="ws-msg__who" aria-hidden="true">
                {m.role === 'user' ? t('assistant.messageFromUser') : t('assistant.messageFromAssistant')}
              </span>
              <p>{typeof m.text === 'string' ? typo(m.text) : m.text}</p>
            </div>
          ))}
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const text = draft.trim();
            if (!text) return;
            assistant.send(text);
            setDraft('');
          }}
          className="ws-card"
        >
          <TextArea label={t('assistant.composer.label')} value={draft} onChange={setDraft} placeholder={t('assistant.composer.placeholder')} rows={3} description={t('assistant.composer.hint')} />
          <div className="ws-actions">
            <Button type="submit" variant="accent">
              {t('assistant.composer.send')}
            </Button>
            <span className="ws-note">{t('assistantPage.noAuthorityNote')}</span>
          </div>
        </form>
      </section>
      <aside className="ws-section" aria-label={t('assistantPage.statsLabel')}>
        <ul className="ws-stats ws-stats--3">
          <li className="ws-stat">
            <strong>{view.mandates.filter((m) => m.state === 'active').length}</strong>
            <span>{t('assistantPage.mandatesSummary')}</span>
          </li>
          <li className="ws-stat">
            <strong>{view.summary.approvals}</strong>
            <span>{t('assistantPage.approvalsWaiting')}</span>
          </li>
          <li className="ws-stat">
            <strong>{view.summary.running}</strong>
            <span>{t('assistantPage.runsInProgress')}</span>
          </li>
        </ul>
        <div className="ws-card ws-card--navy">
          <h3 className="ws-h2">{t('assistantPage.tabs.mandates')}</h3>
          <p className="ws-muted">{typo(t('mandate.noAuthorityNote'))}</p>
        </div>
        <div className="ws-card ws-card--muted">
          <h3 className="ws-h2">{t('assistantPage.howTitle')}</h3>
          <ol className="ws-steps">
            {(['ask', 'mandate', 'approve', 'trace'] as const).map((k, i) => (
              <li key={k}>
                <span className="ws-steps__n" aria-hidden="true">
                  {i + 1}
                </span>
                <span>{typo(t(`assistantPage.how.${k}`))}</span>
              </li>
            ))}
          </ol>
        </div>
      </aside>
    </div>
  );

  const mandates = view.mandates.length ? (
    <div className="ws-section" style={{ maxWidth: '56rem' }}>
      <ul className="ws-list">
        {view.mandates.map((m) => (
          <li key={m.id} className="ws-row">
            <span className="ws-row__main">
              <span className="ws-row__meta">
                <StatusChip size="sm" tone={m.state === 'active' ? 'success' : 'neutral'}>
                  {t(`mandate.state.${m.state}`)}
                </StatusChip>
                <span>{t('mandate.version', { version: m.version })}</span>
              </span>
              <span className="ws-row__title">{typo(m.action)}</span>
              <dl className="ws-facts ws-facts--inline">
                <div>
                  <dt>{t('mandate.context')}</dt>
                  <dd>{typo(m.context)}</dd>
                </div>
                <div>
                  <dt>{t('mandate.limit')}</dt>
                  <dd>{m.limit ?? '—'}</dd>
                </div>
                <div>
                  <dt>{t('mandate.validity')}</dt>
                  <dd>{longDate(m.validUntil)}</dd>
                </div>
                <div>
                  <dt>{t('mandate.approvalPolicy')}</dt>
                  <dd>{t(`mandate.approval.${m.approval}`)}</dd>
                </div>
              </dl>
            </span>
          </li>
        ))}
      </ul>
      <p className="ws-note">{t('mandate.noAuthorityNote')}</p>
    </div>
  ) : (
    <div className="ws-empty">
      <strong>{t('mandate.empty')}</strong>
      <span>{t('mandate.formNote')}</span>
    </div>
  );

  const approvals = view.approvals.length ? (
    <div className="ws-section" style={{ maxWidth: '56rem' }}>
      <ul className="ws-list">
        {view.approvals.map((a) => (
          <li key={a.id} className={`ws-row${a.digestChanged ? ' ws-row--attention' : ''}`}>
            <span className="ws-row__main">
              <span className="ws-row__title">{typo(a.title)}</span>
              <span className="ws-row__meta">
                <span>{typo(a.context)}</span>
                <span>{t('approval.expiresIn', { date: longDate(a.due) })}</span>
              </span>
              {a.digestChanged ? (
                <span className="ws-row__banner" role="status">
                  <AlertCircle size={13} strokeWidth={2} aria-hidden="true" /> {t('approval.invalidated')}
                </span>
              ) : null}
              <span className="ws-note">{t('approval.bindsDigest')}</span>
              <span className="ws-actions">
                <Button size="sm" variant="secondary" isDisabled={a.digestChanged}>
                  {t('approval.approve')}
                </Button>
                <Button size="sm" variant="ghost" isDisabled={a.digestChanged}>
                  {t('approval.reject')}
                </Button>
              </span>
            </span>
            <DateTile date={a.due} tone={a.digestChanged ? 'warn' : 'default'} />
          </li>
        ))}
      </ul>
      <p className="ws-note">{t('assistantPage.approvalsDemoNote')}</p>
    </div>
  ) : (
    <div className="ws-empty">
      <strong>{t('approval.empty')}</strong>
    </div>
  );

  const runs = view.runs.length ? (
    <ul className="ws-list" style={{ maxWidth: '56rem' }}>
      {view.runs.map((r) => (
        <li key={r.id} className="ws-row">
          <span className="ws-row__main">
            <span className="ws-row__meta">
              <RunStatusBadge state={r.state} size="sm" />
            </span>
            <span className="ws-row__title">{typo(r.title)}</span>
            {r.state === 'outcomeUnknown' ? <span className="ws-note">{t('runs.outcomeUnknownExplain')}</span> : null}
          </span>
          <DateTile date={r.at} tone={r.state === 'outcomeUnknown' ? 'warn' : 'default'} />
        </li>
      ))}
    </ul>
  ) : (
    <div className="ws-empty">
      <strong>{t('runs.empty')}</strong>
    </div>
  );

  return (
    <Tabs
      aria-label={t('assistant.title')}
      tabs={[
        { id: 'conversation', label: t('assistantPage.tabs.conversation'), content: conversation },
        { id: 'mandates', label: t('assistantPage.tabs.mandates'), content: mandates },
        { id: 'approvals', label: t('assistantPage.tabs.approvals'), content: approvals },
        { id: 'runs', label: t('assistantPage.tabs.runs'), content: runs },
      ]}
    />
  );
}
