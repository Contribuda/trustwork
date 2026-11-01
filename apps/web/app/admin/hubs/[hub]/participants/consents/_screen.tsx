import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { SelectField, TextInput } from '../../../../_components/forms';
import { dateTime } from '../../../../_components/format';
import { ConsoleHeader, Panel } from '../../../../_components/shell';
import { submitParticipantsCommand } from '../_actions';
import { CONSENT_EVIDENCE, CONSENT_KINDS, participantsOf, PORTRAIT_SCOPES } from '../_fixtures';
import { Count, fixturesOn, Lang, SectionForm, Table } from '../_kit';

async function Consents(ctx: HubContext) {
  const data = participantsOf(fixturesOn(ctx) ? ctx.record.hub.id : '');
  const zone = ctx.record.hub.timeZone;
  const evidence = CONSENT_EVIDENCE.map((e) => ({ value: e, label: tDynamic(`adminParticipants.consents.evidenceKinds.${e}`, e) }));
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminParticipants.consents.title')} lede={t('adminParticipants.consents.lede')} />
      <Panel id="records" title={t('adminParticipants.consents.records')}>
        <Table
          testid="consent-counts"
          rows={data.consentCounts}
          rowKey={(c) => `${c.kind}-${c.version}`}
          empty={t('adminParticipants.consents.none')}
          columns={[
            { label: t('adminParticipants.consents.kind'), render: (c) => tDynamic(`adminParticipants.consents.kinds.${c.kind}`, c.kind) },
            { label: t('adminParticipants.consents.version'), render: (c) => c.version },
            { label: t('adminParticipants.consents.given'), render: (c) => <Count value={c.given} /> },
            { label: t('adminParticipants.consents.withdrawn'), render: (c) => <Count value={c.withdrawn} /> },
          ]}
        />
        <p className="admin-note">{t('adminParticipants.common.cohortNote')}</p>
      </Panel>
      <Panel id="withdrawals" title={t('adminParticipants.consents.withdrawals')}>
        <Table
          testid="withdrawals"
          rows={data.withdrawals}
          rowKey={(w) => w.id}
          empty={t('adminParticipants.consents.noWithdrawals')}
          columns={[
            { label: t('adminParticipants.consents.kind'), render: (w) => tDynamic(`adminParticipants.consents.kinds.${w.kind}`, w.kind) },
            { label: t('adminParticipants.common.name'), render: (w) => <Lang text={w.subject} /> },
            { label: t('adminParticipants.consents.requested'), render: (w) => dateTime(w.requestedAt, zone) },
            { label: t('adminParticipants.consents.unpublishBy'), render: (w) => dateTime(w.unpublishBy, zone) },
          ]}
        />
        {data.withdrawals.length ? (
          <SectionForm ctx={ctx} action={submitParticipantsCommand} command="consents.withdrawal" submit={t('adminParticipants.consents.process')} can={['admin.people.consent.record']}>
            <SelectField name="withdrawalId" label={t('adminParticipants.consents.withdrawal')} options={data.withdrawals.map((w) => ({ value: w.id, label: `${tDynamic(`adminParticipants.consents.kinds.${w.kind}`, w.kind)}: ${w.subject.value}` }))} />
            <p className="admin-note">{t('adminParticipants.consents.processNote')}</p>
          </SectionForm>
        ) : null}
      </Panel>
      <div className="admin-grid">
        <Panel id="record-consent" title={t('adminParticipants.consents.record')}>
          <SectionForm ctx={ctx} action={submitParticipantsCommand} command="consents.record" submit={t('adminParticipants.consents.record')} can={['admin.people.consent.record']} variant="secondary">
            <TextInput name="subjectId" label={t('adminParticipants.consents.subject')} isRequired description={t('adminParticipants.consents.subjectHelp')} />
            <SelectField name="kind" label={t('adminParticipants.consents.kind')} options={CONSENT_KINDS.map((k) => ({ value: k, label: tDynamic(`adminParticipants.consents.kinds.${k}`, k) }))} />
            <SelectField name="evidence" label={t('adminParticipants.consents.evidence')} options={evidence} />
          </SectionForm>
        </Panel>
        <Panel id="record-portrait" title={t('adminParticipants.consents.portrait')}>
          <SectionForm ctx={ctx} action={submitParticipantsCommand} command="consents.portrait" submit={t('adminParticipants.consents.portrait')} can={['admin.people.portrait.licence']} variant="secondary">
            <TextInput name="subjectId" label={t('adminParticipants.consents.subject')} isRequired />
            <SelectField name="scope" label={t('adminParticipants.consents.scope')} options={PORTRAIT_SCOPES.map((s) => ({ value: s, label: tDynamic(`adminParticipants.consents.scopes.${s}`, s) }))} />
            <SelectField name="evidence" label={t('adminParticipants.consents.evidence')} options={evidence} />
          </SectionForm>
        </Panel>
      </div>
    </>
  );
}

/** HC-25 Consents: consent and portrait licence records by kind, version and state, and withdrawals waiting for unpublication. */
export const screen: Screen = { group: 'participants', id: 'consents', title: () => t('adminParticipants.consents.title'), render: Consents };
