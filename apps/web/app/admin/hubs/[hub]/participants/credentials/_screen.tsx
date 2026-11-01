import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { SelectField, TextInput } from '../../../../_components/forms';
import { dateTime, localized, number } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel, StatusLabel } from '../../../../_components/shell';
import { submitParticipantsCommand } from '../_actions';
import { CHECKED_CLAIMS, CREDENTIAL_REVOCATION_REASONS, participantsOf } from '../_fixtures';
import { Count, fixturesOn, Lang, Pill, SectionForm, Table } from '../_kit';

async function Credentials(ctx: HubContext) {
  const data = participantsOf(fixturesOn(ctx) ? ctx.record.hub.id : '');
  const title = (typeId: string) => {
    const type = data.credentialTypes.find((x) => x.id === typeId);
    return type ? localized(type.title, [ctx.record.hub.defaultLocale]) : { text: typeId, lang: 'en' };
  };
  const recipeKey = (id: string | null) => data.recipes.find((r) => r.id === id)?.key ?? null;
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminParticipants.credentials.title')} lede={t('adminParticipants.credentials.lede')} />
      <p className="admin-callout" role="note">
        {t('adminParticipants.credentials.notAScore')}
      </p>
      <Panel id="types" title={t('adminParticipants.credentials.types')}>
        <Table
          testid="credential-types"
          rows={data.credentialTypes}
          rowKey={(c) => c.id}
          empty={t('adminParticipants.credentials.noTypes')}
          columns={[
            { label: t('adminParticipants.credentials.typeTitle'), render: (c) => <span lang={title(c.id).lang}>{title(c.id).text}</span> },
            { label: t('adminParticipants.credentials.claim'), render: (c) => tDynamic(`adminParticipants.credentials.claims.${c.claim}`, c.claim) },
            { label: t('adminParticipants.credentials.subject'), render: (c) => tDynamic(`adminParticipants.subjects.${c.subject}`, c.subject) },
            { label: t('adminParticipants.credentials.recipe'), render: (c) => (recipeKey(c.verificationRecipeId) ? <code className="admin-code">{recipeKey(c.verificationRecipeId)}</code> : t('adminParticipants.credentials.noRecipe')) },
            {
              label: t('adminParticipants.credentials.validity'),
              render: (c) => (
                <>
                  {c.validityDays ? t('adminParticipants.verification.days', { days: c.validityDays }) : t('adminParticipants.credentials.noExpiry')}
                  {c.portable ? <div className="admin-meta">{t('adminParticipants.credentials.portable')}</div> : null}
                </>
              ),
            },
            { label: t('adminParticipants.companies.state'), render: (c) => <Pill tone={c.status === 'active' ? 'pass' : 'neutral'}>{tDynamic(`adminParticipants.credentials.statuses.${c.status}`, c.status)}</Pill> },
          ]}
        />
        <SectionForm ctx={ctx} action={submitParticipantsCommand} command="credentials.type_version" submit={t('adminParticipants.credentials.saveType')} can={['admin.credentials.types.edit']} variant="secondary">
          <SelectField name="typeId" label={t('adminParticipants.credentials.type')} options={data.credentialTypes.map((c) => ({ value: c.id, label: title(c.id).text }))} />
          <SelectField
            name="recipeId"
            label={t('adminParticipants.credentials.recipe')}
            options={[{ value: 'none', label: t('adminParticipants.credentials.noRecipe') }, ...data.recipes.map((r) => ({ value: r.id, label: `${r.key} v${r.version}` }))]}
            description={t('adminParticipants.credentials.recipeRule', { claims: CHECKED_CLAIMS.map((c) => tDynamic(`adminParticipants.credentials.claims.${c}`, c)).join(', ') })}
          />
          <SelectField
            name="activate"
            label={t('adminParticipants.credentials.activation')}
            options={[
              { value: 'off', label: t('adminParticipants.credentials.keepDraft') },
              { value: 'on', label: t('adminParticipants.credentials.activate') },
            ]}
          />
        </SectionForm>
      </Panel>
      <Panel id="issued" title={t('adminParticipants.credentials.issued')}>
        <Table
          testid="issued-counts"
          rows={data.issuedCounts}
          rowKey={(c) => c.typeId}
          empty={t('adminParticipants.credentials.noneIssued')}
          columns={[
            { label: t('adminParticipants.credentials.type'), render: (c) => <span lang={title(c.typeId).lang}>{title(c.typeId).text}</span> },
            ...(['valid', 'expired', 'suspended', 'revoked'] as const).map((state) => ({ label: tDynamic(`adminParticipants.credentials.issuedStates.${state}`, state), render: (c: (typeof data.issuedCounts)[number]) => <Count value={c[state]} /> })),
          ]}
        />
        <p className="admin-note">{t('adminParticipants.common.cohortNote')}</p>
        <p className="admin-meta">
          {t('adminParticipants.credentials.holderSearch')} <StatusLabel status="designed" />
        </p>
      </Panel>
      {data.statusList ? (
        <Panel id="status-list" title={t('adminParticipants.credentials.statusList')}>
          <KeyValues
            rows={[
              { label: t('adminParticipants.credentials.published'), value: dateTime(data.statusList.publishedAt, ctx.record.hub.timeZone) },
              { label: t('adminParticipants.credentials.entries'), value: number(data.statusList.entries) },
              { label: t('adminParticipants.credentials.signature'), value: <Pill tone="pass">{t('adminParticipants.credentials.signatureValid')}</Pill> },
              { label: t('adminParticipants.credentials.signingKey'), value: <code className="admin-code">{data.statusList.signingKeyId}</code> },
            ]}
          />
        </Panel>
      ) : null}
      <div className="admin-grid">
        <Panel id="issue" title={t('adminParticipants.credentials.issue')}>
          <SectionForm ctx={ctx} action={submitParticipantsCommand} command="credentials.issue" submit={t('adminParticipants.credentials.issue')} can={['admin.credentials.issue']}>
            <SelectField
              name="decisionId"
              label={t('adminParticipants.credentials.decision')}
              options={data.issuable.map((d) => ({ value: d.id, label: `${title(d.typeId).text}: ${d.holder.value}` }))}
              description={t('adminParticipants.credentials.issueRule')}
            />
          </SectionForm>
          {data.issuable.length ? (
            <ul className="admin-list">
              {data.issuable.map((d) => (
                <li key={d.id} className="admin-list__row">
                  <Lang text={d.holder} />
                  <span className="admin-meta">{t('adminParticipants.credentials.evidenceCount', { count: d.evidence })}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
        <Panel id="revoke" title={t('adminParticipants.credentials.revokeOrSuspend')}>
          <SectionForm ctx={ctx} action={submitParticipantsCommand} command="credentials.revoke" submit={t('adminParticipants.credentials.revoke')} can={['admin.credentials.revoke']} variant="danger">
            <TextInput name="credentialId" label={t('adminParticipants.credentials.credentialId')} isRequired description={t('adminParticipants.credentials.credentialIdHelp')} />
            <SelectField name="category" label={t('adminParticipants.common.reasonCategory')} options={CREDENTIAL_REVOCATION_REASONS.map((r) => ({ value: r, label: tDynamic(`adminParticipants.credentials.reasons.${r}`, r) }))} />
            <p className="admin-note">{t('adminParticipants.credentials.revokeNote')}</p>
          </SectionForm>
          <SectionForm ctx={ctx} action={submitParticipantsCommand} command="credentials.suspend" submit={t('adminParticipants.credentials.suspend')} can={['admin.credentials.revoke']} variant="secondary">
            <TextInput name="credentialId" label={t('adminParticipants.credentials.credentialId')} isRequired />
            <SelectField name="category" label={t('adminParticipants.common.reasonCategory')} options={CREDENTIAL_REVOCATION_REASONS.map((r) => ({ value: r, label: tDynamic(`adminParticipants.credentials.reasons.${r}`, r) }))} />
          </SectionForm>
        </Panel>
      </div>
    </>
  );
}

/** HC-24 Credentials: verifiable credential types, issued counts by state (cohorts), the status list and the signing key. */
export const screen: Screen = { group: 'participants', id: 'credentials', title: () => t('adminParticipants.credentials.title'), render: Credentials };
