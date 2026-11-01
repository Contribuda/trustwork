import { t, tDynamic } from '@/app/_lib/i18n';
import type { HubContext } from '../../../../_components/context';
import type { Screen, ScreenRoute } from '../../../../_components/screen';
import { SelectField } from '../../../../_components/forms';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { submitSupportCommand } from '../_actions';
import { EXPLANATIONS, supportOf } from '../_fixtures';
import { fixturesOn, GetForm, Lang, Pill, SectionForm } from '../../participants/_kit';

function Select({ name, label, value, options }: { name: string; label: string; value: string; options: ReadonlyArray<{ value: string; label: string }> }) {
  return (
    <div className="admin-field">
      <label htmlFor={`explain-${name}`} className="admin-field__label">
        {label}
      </label>
      <select id={`explain-${name}`} name={name} className="admin-select" defaultValue={value}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Explain(ctx: HubContext, route: ScreenRoute) {
  const d = supportOf(fixturesOn(ctx) ? ctx.record.hub.id : '');
  const principal = d.principals.find((p) => p.id === route.query.principal) ?? null;
  const object = d.objects.find((o) => o.id === route.query.object) ?? null;
  const decision = principal && object ? (EXPLANATIONS.find((e) => e.principal === principal.id && e.object === object.id) ?? null) : null;
  const objectLabel = (o: (typeof d.objects)[number]) => `${tDynamic(`adminSupport.explain.objectKinds.${o.kind}`, o.kind)} ${o.id}`;
  const openCases = d.cases.filter((c) => c.state !== 'closed');
  return (
    <>
      <ConsoleHeader ctx={ctx} title={t('adminSupport.explain.title')} lede={t('adminSupport.explain.lede')} />
      <Panel id="ask" title={t('adminSupport.explain.ask')}>
        <GetForm ctx={ctx} path="support/explain" submit={t('adminSupport.explain.explain')} id="explain-form">
          <Select name="principal" label={t('adminSupport.explain.principal')} value={principal?.id ?? ''} options={[{ value: '', label: t('adminSupport.explain.choose') }, ...d.principals.map((p) => ({ value: p.id, label: p.name.value }))]} />
          <Select name="object" label={t('adminSupport.explain.object')} value={object?.id ?? ''} options={[{ value: '', label: t('adminSupport.explain.choose') }, ...d.objects.map((o) => ({ value: o.id, label: objectLabel(o) }))]} />
        </GetForm>
      </Panel>
      {principal && object ? (
        <Panel id="decision" title={t('adminSupport.explain.decision')}>
          {decision ? (
            <>
              <KeyValues
                rows={[
                  { label: t('adminSupport.explain.principal'), value: <Lang text={principal.name} /> },
                  { label: t('adminSupport.explain.object'), value: objectLabel(object) },
                  { label: t('adminSupport.explain.effect'), value: <Pill tone={decision.effect === 'allow' ? 'pass' : 'fail'}>{tDynamic(`adminSupport.explain.effects.${decision.effect}`, decision.effect)}</Pill> },
                  { label: t('adminSupport.explain.rule'), value: <code className="admin-code">{decision.rule}</code> },
                ]}
              />
              <ul className="admin-list" data-testid="explain-reasons">
                {decision.reasons.map((r) => (
                  <li key={r} className="admin-list__row">
                    <code className="admin-code">{r}</code> {tDynamic(`adminSupport.explain.reasons.${r}`, r)}
                  </li>
                ))}
              </ul>
              <p className="admin-note">{t('adminSupport.explain.noContent')}</p>
              <SectionForm ctx={ctx} action={submitSupportCommand} command="explain.copy" fields={{ principal: principal.id, object: object.id }} submit={t('adminSupport.explain.copy')} can={['admin.support.explain']} variant="secondary">
                <SelectField name="caseId" label={t('adminSupport.account.case')} options={openCases.map((c) => ({ value: c.id, label: `${c.id} · ${c.subject.name.value}` }))} />
              </SectionForm>
            </>
          ) : (
            <p className="admin-empty">{t('adminSupport.explain.noDecision')}</p>
          )}
        </Panel>
      ) : null}
    </>
  );
}

/** HC-35 Access explainer: why a principal can or cannot see an object, as reason codes and rules, never the object's content. */
export const screen: Screen = { group: 'support', id: 'explain', title: () => t('adminSupport.explain.title'), render: Explain };
