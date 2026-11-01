import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import type { ConsolePermission } from '@trustwork/contracts/client';
import { OUTREACH_ENGINE_FLOOR } from './policy';
import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import { TextInput } from '../../../../_components/forms';
import { dateTime, languageName, list } from '../../../../_components/format';
import { KeyValues, Panel } from '../../../../_components/shell';
import { fixturesOn, GetForm, Pill, SectionForm } from '../../participants/_kit';
import { Cohort } from '../../modules/_kit/parts';
import { submitOutreachCommand } from '../_actions';
import { outreachOf } from './fixtures';
import { exactSuppression, normaliseIdentifier } from './lookup';
import { activePolicy, type Gate, type MessagePreview, type OutreachView } from './schemas';

/* Building blocks of the outreach screens (OUTR-004): PolicyGateList, MessagePreview, SuppressionLookup, the strict
 * banner and the engine floor as rows without switches. Strings come from `adminOutreach.*`. */

/** The hub's outreach view; live mode has no outreach backend in the console yet (OUTR-002), so it is not found. */
export function loadOutreach(ctx: HubContext): OutreachView {
  const view = fixturesOn(ctx) ? outreachOf(ctx.record.hub.id) : null;
  if (!view) notFound();
  return view;
}

/** "Outreach is off": shown on every outreach screen while the strict rule applies or the kill switch is engaged. */
export function OutreachBanner({ view }: { view: OutreachView }) {
  const strict = activePolicy(view).mode === 'strict';
  return (
    <>
      {strict ? (
        <p className="admin-callout" role="status" data-testid="outreach-strict">
          {t('adminOutreach.strictOn')}
        </p>
      ) : null}
      {view.killSwitch === 'engaged' ? (
        <p className="admin-callout admin-callout--warning" role="status" data-testid="outreach-kill-switch">
          {t('adminOutreach.killSwitchEngaged')}
        </p>
      ) : null}
    </>
  );
}

const GATE_TONE = { pass: 'pass', fail: 'fail', wait: 'neutral' } as const;

/** PolicyGateList: each gate with pass, fail or wait, its reason in words and how many recipients stopped there. */
export function PolicyGateList({ gates }: { gates: readonly Gate[] }) {
  return (
    <ol className="admin-list" data-testid="policy-gates">
      {gates.map((g) => (
        <li key={g.id} data-gate={g.id} data-state={g.state}>
          <Pill tone={GATE_TONE[g.state]}>{tDynamic(`adminOutreach.gateStates.${g.state}`, g.state)}</Pill> <strong>{tDynamic(`adminOutreach.gates.${g.id}.name`, g.id)}</strong>
          <span className="admin-meta"> · {tDynamic(`adminOutreach.gates.${g.id}.${g.state}`, '')}</span>
          {g.state === 'fail' ? (
            <span className="admin-meta">
              {' '}
              · {t('adminOutreach.campaigns.stoppedHere')} <Cohort value={g.stopped} />
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** MessagePreview: the message exactly as it would be sent in one language and jurisdiction, locked blocks marked. */
export function MessagePreviewCard({ preview }: { preview: MessagePreview }) {
  const heading = t('adminOutreach.preview.heading', { language: languageName(preview.lang), jurisdiction: preview.jurisdiction });
  return (
    <article className="admin-panel" data-testid="message-preview" data-lang={preview.lang} data-jurisdiction={preview.jurisdiction} aria-label={heading}>
      <h3>{heading}</h3>
      <p lang={preview.lang}>
        <strong>{t('adminOutreach.preview.subject')}</strong> {preview.subject}
      </p>
      <ul className="admin-list">
        {preview.blocks.map((b) => (
          <li key={b.kind} data-block={b.kind} data-locked={b.locked ? 'true' : 'false'}>
            <span className="admin-meta">
              {tDynamic(`adminOutreach.preview.blocks.${b.kind}`, b.kind)} · {b.locked ? t('adminOutreach.preview.locked') : t('adminOutreach.preview.editable')}
            </span>
            <p lang={preview.lang}>{b.text}</p>
          </li>
        ))}
      </ul>
    </article>
  );
}

/** The engine floor as rows of text: constants, never settings, so nothing here can be switched. */
export function EngineFloor() {
  const f = OUTREACH_ENGINE_FLOOR;
  const classes = (items: readonly string[]) => list(items.map((x) => tDynamic(`adminOutreach.classes.${x}`, x)));
  const channels = (items: readonly string[]) => list(items.map((x) => tDynamic(`adminOutreach.channels.${x}`, x)));
  return (
    <div data-testid="engine-floor">
      <KeyValues
        rows={[
          { label: t('adminOutreach.floor.prohibitedClasses'), value: classes(f.prohibitedClasses) },
          { label: t('adminOutreach.floor.prohibitedChannels'), value: channels(f.prohibitedChannels) },
          { label: t('adminOutreach.floor.consentOnly'), value: channels(f.consentOnlyChannels) },
          { label: t('adminOutreach.floor.identification'), value: list(f.requiredIdentification.map((x) => tDynamic(`adminOutreach.identification.${x}`, x))) },
          { label: t('adminOutreach.floor.maxTouches'), value: String(f.maxTouchesPerRecipientPerPurpose) },
          { label: t('adminOutreach.floor.optOut'), value: t('adminOutreach.floor.optOutValue') },
          { label: t('adminOutreach.floor.openTracking'), value: t('adminOutreach.floor.never') },
        ]}
      />
      <p className="admin-note">{t('adminOutreach.floor.note')}</p>
    </div>
  );
}

/** SuppressionLookup: one exact identifier at a time (privacy officer); the lookup is audited and nothing is listed. */
export function SuppressionLookup({ ctx, view, query }: { ctx: HubContext; view: OutreachView; query: string }) {
  const allowed = ctx.can('admin.privacy.request.read');
  const asked = normaliseIdentifier(query);
  const found = allowed && asked ? exactSuppression(view.suppressionLedger, asked) : null;
  return (
    <Panel id="lookup" title={t('adminOutreach.suppression.lookup')}>
      <p className="admin-note">{t('adminOutreach.suppression.noBrowse')}</p>
      {allowed ? (
        <GetForm ctx={ctx} path="outreach/suppression" submit={t('adminOutreach.suppression.find')} id="suppression-lookup">
          <TextInput name="identifier" label={t('adminOutreach.suppression.identifier')} description={t('adminOutreach.suppression.identifierHelp')} isRequired />
        </GetForm>
      ) : (
        <p className="admin-meta">{t('adminOutreach.suppression.privacyOnly')}</p>
      )}
      {allowed && asked ? (
        found ? (
          <div data-testid="suppression-result" data-found="true">
            <KeyValues
              rows={[
                { label: t('adminOutreach.suppression.identifier'), value: <code className="admin-code">{found.identifier}</code> },
                { label: t('adminOutreach.suppression.reason'), value: tDynamic(`adminOutreach.suppression.reasons.${found.reason}`, found.reason) },
                { label: t('adminOutreach.suppression.scope'), value: tDynamic(`adminOutreach.suppression.scopes.${found.scope}`, found.scope) },
                { label: t('adminOutreach.suppression.since'), value: dateTime(found.since, ctx.record.hub.timeZone) },
              ]}
            />
            <p className="admin-meta">{t('adminOutreach.suppression.audited')}</p>
          </div>
        ) : (
          <p className="admin-empty" data-testid="suppression-result" data-found="false">
            {t('adminOutreach.suppression.notFound')}
          </p>
        )
      ) : null}
    </Panel>
  );
}

/** A mutation form of the outreach section: the outreach server action, a reason and the audit note. */
export function OutreachForm(props: { ctx: HubContext; command: string; fields?: Record<string, string>; submit: string; can: readonly ConsolePermission[]; secondPerson?: boolean; blocked?: string | null; variant?: 'primary' | 'secondary' | 'danger'; children?: ReactNode }) {
  return <SectionForm {...props} action={submitOutreachCommand} />;
}

export const purposeName = (purpose: string) => tDynamic(`adminOutreach.purposes.${purpose}`, purpose);
export const className = (recipientClass: string) => tDynamic(`adminOutreach.classes.${recipientClass}`, recipientClass);
export const channelName = (channel: string) => tDynamic(`adminOutreach.channels.${channel}`, channel);
export const stateName = (state: string) => tDynamic(`adminOutreach.states.${state}`, state);
