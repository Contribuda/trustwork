import { intlTag } from '@trustwork/ui/i18n';
import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { SelectField } from '../../../../_components/forms';
import { longDate, number } from '../../../../_components/format';
import { ConsoleHeader, Panel } from '../../../../_components/shell';
import { submitParticipantsCommand } from '../_actions';
import { participantsOf, PROVIDER_MODES } from '../_fixtures';
import { fixturesOn, Lang, Pill, SectionForm, Table } from '../_kit';
import { PACK_LIST_FACTS, trustOf } from '../../trust/_fixtures';

function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(intlTag(), { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${minor / 100} ${currency}`;
  }
}

async function Verification(ctx: HubContext) {
  const hubId = fixturesOn(ctx) ? ctx.record.hub.id : '';
  const data = participantsOf(hubId);
  const lists = trustOf(hubId).lists;
  const currency = ctx.record.hub.currency;
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminParticipants.verification.title')} lede={t('adminParticipants.verification.lede')} />
      <Panel id="recipes" title={t('adminParticipants.verification.recipes')}>
        {data.recipes.length ? (
          <ul className="admin-cards">
            {data.recipes.map((r) => (
              <li key={r.id} className="admin-approval" data-testid={`recipe-${r.key}`}>
                <div className="admin-panel__head">
                  <h3 className="admin-h3">
                    <code className="admin-code">{r.key}</code>
                  </h3>
                  <span className="admin-pill">{t('adminParticipants.common.version', { version: r.version })}</span>
                </div>
                <p className="admin-meta">
                  {tDynamic(`adminParticipants.subjects.${r.subject}`, r.subject)} · {t('adminParticipants.common.updated', { date: longDate(r.updatedAt) })}
                </p>
                <ol className="admin-ordered">
                  {r.steps.map((s) => (
                    <li key={s}>{tDynamic(`adminParticipants.steps.${s}`, s)}</li>
                  ))}
                </ol>
              </li>
            ))}
          </ul>
        ) : (
          <p className="admin-empty">{t('adminParticipants.verification.noRecipes')}</p>
        )}
        <SectionForm ctx={ctx} action={submitParticipantsCommand} command="verification.recipe_version" submit={t('adminParticipants.verification.newRecipeVersion')} can={['admin.claims.policy.edit']} variant="secondary">
          <SelectField name="recipeId" label={t('adminParticipants.verification.recipe')} options={data.recipes.map((r) => ({ value: r.id, label: `${r.key} v${r.version}` }))} />
          <p className="admin-note">{t('adminParticipants.verification.screeningAlwaysOn')}</p>
        </SectionForm>
      </Panel>
      <Panel id="checks" title={t('adminParticipants.verification.checks')}>
        <Table
          testid="check-types"
          rows={data.checks}
          rowKey={(c) => c.id}
          empty={t('adminParticipants.verification.noChecks')}
          columns={[
            { label: t('adminParticipants.verification.check'), render: (c) => tDynamic(`adminParticipants.steps.${c.check}`, c.check) },
            { label: t('adminParticipants.verification.provider'), render: (c) => <Lang text={c.provider} /> },
            { label: t('adminParticipants.verification.mode'), render: (c) => <Pill tone={c.mode === 'live' ? 'pass' : 'neutral'}>{tDynamic(`adminParticipants.modes.${c.mode}`, c.mode)}</Pill> },
            {
              label: t('adminParticipants.verification.costAndUse'),
              render: (c) => (
                <>
                  {money(c.costMinor, currency)}
                  <div className="admin-meta">{t('adminParticipants.verification.quotaUse', { used: number(c.usedThisMonth), quota: number(c.quotaPerMonth) })}</div>
                </>
              ),
            },
            {
              label: t('adminParticipants.verification.retentionAndBasis'),
              render: (c) => (
                <>
                  {t('adminParticipants.verification.days', { days: c.retentionDays })}
                  <div className="admin-meta">{tDynamic(`adminParticipants.legalBases.${c.legalBasis}`, c.legalBasis)}</div>
                </>
              ),
            },
          ]}
        />
        <p className="admin-note">{t('adminParticipants.verification.costNote')}</p>
        <SectionForm ctx={ctx} action={submitParticipantsCommand} command="verification.provider_mode" submit={t('adminParticipants.verification.setMode')} can={['admin.claims.policy.edit', 'admin.providers.toggle']} secondPerson>
          <SelectField name="checkId" label={t('adminParticipants.verification.check')} options={data.checks.map((c) => ({ value: c.id, label: tDynamic(`adminParticipants.steps.${c.check}`, c.check) }))} />
          <SelectField name="mode" label={t('adminParticipants.verification.mode')} options={PROVIDER_MODES.map((m) => ({ value: m, label: tDynamic(`adminParticipants.modes.${m}`, m) }))} description={t('adminParticipants.verification.liveNote')} />
        </SectionForm>
      </Panel>
      <Panel id="screening-lists" title={t('adminParticipants.verification.lists')}>
        <Table
          testid="screening-lists"
          rows={lists}
          rowKey={(l) => l.code}
          empty={t('adminParticipants.verification.noLists')}
          columns={[
            { label: t('adminParticipants.verification.list'), render: (l) => <code className="admin-code">{l.code}</code> },
            { label: t('adminParticipants.verification.kind'), render: (l) => (l.baseline ? <strong>{t('adminParticipants.verification.baselineAlwaysOn')}</strong> : t('adminParticipants.verification.additional')) },
            { label: t('adminParticipants.verification.mode'), render: (l) => tDynamic(`adminParticipants.modes.${l.mode}`, l.mode) },
            { label: t('adminParticipants.verification.lastUpdate'), render: (l) => longDate(l.publishedAt) },
          ]}
        />
        <SectionForm ctx={ctx} action={submitParticipantsCommand} command="verification.add_list" submit={t('adminParticipants.verification.addList')} can={['admin.claims.policy.edit']} secondPerson variant="secondary">
          <SelectField name="list" label={t('adminParticipants.verification.packList')} options={PACK_LIST_FACTS.filter((code) => !lists.some((l) => l.code === code)).map((code) => ({ value: code, label: code }))} />
          <SelectField name="mode" label={t('adminParticipants.verification.mode')} options={PROVIDER_MODES.map((m) => ({ value: m, label: tDynamic(`adminParticipants.modes.${m}`, m) }))} />
        </SectionForm>
      </Panel>
    </>
  );
}

/** HC-23 Verification: recipes, check providers with mode, cost, quota, retention and legal basis, and screening lists (baseline always on). */
export const screen: Screen = { group: 'participants', id: 'verification', title: () => t('adminParticipants.verification.title'), render: Verification };
