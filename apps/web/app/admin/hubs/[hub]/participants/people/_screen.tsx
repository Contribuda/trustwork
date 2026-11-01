import NextLink from '@/components/locale/LocalLink';
import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { SelectField } from '../../../../_components/forms';
import { ConsoleHeader, Panel } from '../../../../_components/shell';
import { submitParticipantsCommand } from '../_actions';
import { participantsOf, ACCOUNT_STATES, FLAG_CATEGORIES } from '../_fixtures';
import { Count, fixturesOn, Lang, SectionForm, Table, Tiles } from '../_kit';

async function People(ctx: HubContext) {
  const data = participantsOf(fixturesOn(ctx) ? ctx.record.hub.id : '');
  const support = ctx.can('admin.support.account.read');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminParticipants.people.title')} lede={t('adminParticipants.people.lede')} />
      <Panel id="account-states" title={t('adminParticipants.people.accountStates')}>
        {data.accountStates ? (
          <Tiles testid="account-states" items={ACCOUNT_STATES.map((s) => ({ key: s, label: tDynamic(`adminParticipants.accountStates.${s}`, s), value: <Count value={data.accountStates![s]} /> }))} />
        ) : (
          <p className="admin-empty">{t('adminParticipants.common.noData')}</p>
        )}
        <p className="admin-note">{t('adminParticipants.common.cohortNote')}</p>
      </Panel>
      {data.problems ? (
        <Panel id="problems" title={t('adminParticipants.people.problems')}>
          <Tiles
            items={[
              { key: 'consent', label: t('adminParticipants.people.consentWithdrawn'), value: <Count value={data.problems.consentWithdrawn} /> },
              { key: 'portrait', label: t('adminParticipants.people.portraitMissing'), value: <Count value={data.problems.portraitMissing} /> },
            ]}
          />
        </Panel>
      ) : null}
      <Panel id="profiles" title={t('adminParticipants.people.profiles')}>
        <p className="admin-note">{t('adminParticipants.people.publicOnly')}</p>
        <Table
          testid="public-profiles"
          caption={t('adminParticipants.people.profiles')}
          rows={data.profiles}
          rowKey={(p) => p.id}
          empty={t('adminParticipants.people.noProfiles')}
          columns={[
            { label: t('adminParticipants.common.name'), render: (p) => <Lang text={p.name} /> },
            { label: t('adminParticipants.people.trade'), render: (p) => tDynamic(`adminParticipants.trades.${p.trade}`, p.trade) },
            { label: t('adminParticipants.people.place'), render: (p) => <Lang text={p.place} /> },
            { label: t('adminParticipants.people.employer'), render: (p) => (p.employer ? <Lang text={p.employer} /> : t('admin.common.none')) },
            {
              label: t('adminParticipants.people.portrait'),
              render: (p) => (
                <>
                  {tDynamic(`adminParticipants.people.portraitStates.${p.portrait}`, p.portrait)}
                  {p.consentProblem ? <span className="admin-warning"> · {t('adminParticipants.people.consentProblem')}</span> : null}
                </>
              ),
            },
            {
              label: t('adminParticipants.common.support'),
              render: () => (support ? <NextLink href={ctx.href('support')}>{t('adminParticipants.people.openInSupport')}</NextLink> : <span className="admin-meta">{t('adminParticipants.people.supportOnly')}</span>),
            },
          ]}
        />
      </Panel>
      <Panel id="flag" title={t('adminParticipants.people.flag')}>
        <SectionForm ctx={ctx} action={submitParticipantsCommand} command="people.flag" submit={t('adminParticipants.people.flag')} can={['admin.people.flag', 'admin.moderation.case.open']}>
          <SelectField name="profileId" label={t('adminParticipants.people.profile')} options={data.profiles.map((p) => ({ value: p.id, label: p.name.value }))} />
          <SelectField name="category" label={t('adminParticipants.common.category')} options={FLAG_CATEGORIES.map((c) => ({ value: c, label: tDynamic(`adminParticipants.people.flagCategories.${c}`, c) }))} />
          <p className="admin-note">{t('adminParticipants.people.flagNote')}</p>
        </SectionForm>
      </Panel>
    </>
  );
}

/** HC-20 People: public profiles as the public sees them, account-state cohorts and profile problems; staff never edit profile content. */
export const screen: Screen = { group: 'participants', id: 'people', title: () => t('adminParticipants.people.title'), render: People };
