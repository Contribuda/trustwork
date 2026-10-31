import type { HubStaffRole } from '@trustwork/contracts/client';
import { t, tDynamic } from '@/app/_lib/i18n';
import { HelpChecklist } from '../../../_components/HelpChecklist';
import type { HubContext } from '../../../_components/context';
import type { Screen } from '../../../_components/screen';
import { ConsoleHeader, Panel, StatusLabel } from '../../../_components/shell';

const REPOSITORY = 'https://github.com/Contribuda/trustwork/blob/main/';
const HANDBOOK = [
  { id: 'console', path: 'docs/engine/hub-console/README.md' },
  { id: 'screens', path: 'docs/engine/hub-console/screens.md' },
  { id: 'setup', path: 'docs/engine/hub-console/setup-wizard.md' },
  { id: 'guardRails', path: 'docs/engine/hub-administration.md' },
] as const;
/** Role checklists ("first week as …"); everyone gets the general one, and each role the viewer holds adds its own. */
const CHECKLISTS: Partial<Record<HubStaffRole | 'everyone', readonly string[]>> = {
  everyone: ['secondFactor', 'readGuardRails', 'statusLabels'],
  'hub-owner': ['secondStaff', 'launchGates', 'legal', 'approvals'],
  'editor-in-chief': ['policy', 'sources', 'reviewRules'],
  'data-steward': ['countryBase', 'taxonomy', 'firstSource'],
  'support-lead': ['caseGrants', 'recovery', 'noImpersonation'],
};
const GLOSSARY = ['hub', 'node', 'lifecycle', 'elevation', 'secondPerson', 'digest', 'killSwitch', 'launchGate', 'configVersion', 'demoData', 'caseGrant'] as const;
const STATUSES = ['live', 'demo', 'contract', 'designed', 'proposed'] as const;
const MODES = ['fake', 'manual', 'live'] as const;
const KEYS = ['skip', 'order', 'menu', 'forms'] as const;

function Help(ctx: HubContext) {
  const lists = (['everyone', ...ctx.access.roles] as const).filter((id): id is keyof typeof CHECKLISTS => Boolean(CHECKLISTS[id as keyof typeof CHECKLISTS]));
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('admin.help.title')} lede={t('admin.help.lede')} />
      <div className="admin-grid">
        <Panel id="checklists" title={t('admin.help.checklists')}>
          <p className="admin-meta">{t('admin.help.checklistNote')}</p>
          {lists.map((id) => (
            <section key={id} aria-labelledby={`checklist-${id}`} className="admin-subsection">
              <h3 id={`checklist-${id}`} className="admin-h3">
                {id === 'everyone' ? t('admin.help.checklist.everyone') : t('admin.help.checklistFor', { role: tDynamic(`admin.roles.${id}`, id) })}
              </h3>
              <HelpChecklist id={id} items={(CHECKLISTS[id] ?? []).map((item) => ({ id: item, label: tDynamic(`admin.help.items.${item}`, item) }))} />
            </section>
          ))}
        </Panel>
        <Panel id="handbook" title={t('admin.help.handbook')}>
          <ul className="admin-list">
            {HANDBOOK.map((doc) => (
              <li key={doc.id}>
                <a href={`${REPOSITORY}${doc.path}`} rel="noopener noreferrer" target="_blank">
                  {tDynamic(`admin.help.docs.${doc.id}`, doc.id)}
                  <span className="admin-visually-hidden"> {t('admin.common.opensNewTab')}</span>
                </a>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel id="statuses" title={t('admin.help.statuses')}>
          <dl className="admin-dl">
            {STATUSES.map((s) => (
              <div key={s} className="admin-dl__row">
                <dt>
                  <StatusLabel status={s} />
                </dt>
                <dd>{t(`admin.help.status.${s}`)}</dd>
              </div>
            ))}
            {MODES.map((m) => (
              <div key={m} className="admin-dl__row">
                <dt>{t(`admin.providerMode.${m}`)}</dt>
                <dd>{t(`admin.help.mode.${m}`)}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel id="glossary" title={t('admin.help.glossary')}>
          <dl className="admin-dl admin-dl--stacked">
            {GLOSSARY.map((term) => (
              <div key={term} className="admin-dl__row">
                <dt>{t(`admin.help.terms.${term}.term`)}</dt>
                <dd>{t(`admin.help.terms.${term}.definition`)}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        <Panel id="keyboard" title={t('admin.help.keyboard')}>
          <ul className="admin-list">
            {KEYS.map((k) => (
              <li key={k}>{t(`admin.help.keys.${k}`)}</li>
            ))}
          </ul>
        </Panel>
      </div>
    </>
  );
}

/** HC-03 Help: role checklists, handbook links, status labels, glossary and keyboard use. */
export const screen: Screen = { group: 'home', id: 'help', title: () => t('admin.help.title'), render: Help };
