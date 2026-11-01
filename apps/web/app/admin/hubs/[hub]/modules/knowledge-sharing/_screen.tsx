import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import type { Screen } from '../../../../_components/screen';
import { formLabels, readOnlyReason } from '../../../../_components/forms';
import { list } from '../../../../_components/format';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Empty, loadProduct, StatePill, UniqueSelect, yesNo } from '../_kit/parts';

async function KnowledgeSharing(ctx: HubContext) {
  const { knowledge } = (await loadProduct(ctx)).modules;
  const canReview = ctx.can('admin.knowledge.shares.review');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.modules.knowledgeSharing.title')} lede={t('admin.modules.knowledgeSharing.lede')} />
      <Panel id="shares" title={t('admin.modules.knowledgeSharing.shares')}>
        {knowledge.shares.length ? (
          <ul className="admin-approvals">
            {knowledge.shares.map(({ share, projectTitle, parties }) => {
              const missing = parties.filter((p) => p.consent !== 'given');
              return (
                <li key={share.id} className="admin-approval" data-testid={`share-${share.id}`}>
                  <div className="admin-panel__head">
                    <h3 className="admin-h3">
                      <span lang={projectTitle.lang}>{projectTitle.text}</span>
                    </h3>
                    <StatePill state={share.status} />
                  </div>
                  <KeyValues
                    rows={[
                      { label: t('admin.modules.knowledgeSharing.kind'), value: tDynamic(`admin.modules.knowledgeSharing.kinds.${share.kind}`, share.kind) },
                      { label: t('admin.modules.knowledgeSharing.privateFields'), value: t('admin.modules.knowledgeSharing.privateExcluded') },
                    ]}
                  />
                  <h4 className="admin-h4">{t('admin.modules.knowledgeSharing.consents')}</h4>
                  <ul className="admin-list">
                    {parties.map((p) => (
                      <li key={`${p.kind}-${p.label.text}`} className="admin-list__row">
                        <span>
                          {tDynamic(`admin.modules.knowledgeSharing.partyKinds.${p.partyKind}`, p.partyKind)}: <span lang={p.label.lang}>{p.label.text}</span>
                        </span>
                        <StatePill state={`consent_${p.consent}`} tone={p.consent === 'given' ? 'on' : 'warn'} />
                      </li>
                    ))}
                  </ul>
                  {missing.length ? (
                    <p className="admin-callout admin-callout--warning" data-testid="consent-missing">
                      {t('admin.modules.knowledgeSharing.noConsent')}{' '}
                      {missing.map((p, i) => (
                        <span key={p.label.text}>
                          {i ? ', ' : ''}
                          {tDynamic(`admin.modules.knowledgeSharing.partyKinds.${p.partyKind}`, p.partyKind)} <span lang={p.label.lang}>{p.label.text}</span>
                        </span>
                      ))}
                    </p>
                  ) : null}
                  <ConsoleForm
                    action={submitConsoleCommand}
                    hidden={ctx.hidden('knowledge.decide', { 'f.shareId': share.id })}
                    labels={formLabels({ submit: t('admin.modules.knowledgeSharing.decide') })}
                    disabledReason={readOnlyReason(canReview, ctx.offline)}
                  >
                    <UniqueSelect
                      id={`decision-${share.id}`}
                      name="decision"
                      label={t('admin.modules.knowledgeSharing.decision')}
                      options={[
                        ...(missing.length ? [] : [{ value: 'publish', label: t('admin.modules.knowledgeSharing.publish') }]),
                        { value: 'return', label: t('admin.modules.knowledgeSharing.return') },
                        { value: 'withdraw', label: t('admin.modules.knowledgeSharing.withdraw') },
                      ]}
                      description={missing.length ? t('admin.modules.knowledgeSharing.publishDisabled') : undefined}
                    />
                  </ConsoleForm>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>{t('admin.modules.knowledgeSharing.noShares')}</Empty>
        )}
      </Panel>
      <Panel id="knowledge-settings" title={t('admin.modules.knowledgeSharing.settings')}>
        <KeyValues
          rows={[
            { label: t('admin.modules.knowledgeSharing.kindsAccepted'), value: list(knowledge.kindsAccepted.map((k) => tDynamic(`admin.modules.knowledgeSharing.kinds.${k}`, k))) },
            { label: t('admin.modules.knowledgeSharing.anonymised'), value: yesNo(knowledge.anonymisedAllowed) },
            { label: t('admin.modules.knowledgeSharing.mentoring'), value: yesNo(knowledge.mentoring) },
          ]}
        />
        <p className="admin-note">{t('admin.modules.knowledgeSharing.guard')}</p>
      </Panel>
    </>
  );
}

/** HC-63 Shared knowledge: publish consented project knowledge after review; a missing consent names the party and blocks publishing. */
export const screen: Screen = { group: 'modules', id: 'knowledgeSharing', title: () => t('admin.modules.knowledgeSharing.title'), render: KnowledgeSharing };
