import { t, tDynamic } from '@/app/_lib/i18n';
import { submitConsoleCommand } from '../../../../_data/actions';
import { activeRecipes, type LiveOption, type VerificationCredential, type VerificationProvider, type VerificationRecipe, type VerificationView } from '../../../../_data/live-verification';
import { ConsoleForm } from '../../../../_components/ConsoleForm';
import type { HubContext } from '../../../../_components/context';
import { FieldGroup, formLabels, readOnlyReason, SelectField, TextInput } from '../../../../_components/forms';
import { longDate } from '../../../../_components/format';
import type { ScreenRoute } from '../../../../_components/screen';
import { ConsoleHeader, KeyValues, Panel } from '../../../../_components/shell';
import { Pill, StaffName, staffNames, Table, type StaffNames } from '../_kit';
import { CHOOSABLE_CHECKS, REGISTERED_PROVIDER_MODES, STEP_USES, VERIFICATION_LEGAL_BASES, VERIFICATION_SUBJECTS, VERIFICATION_TRIGGERS, type StepUse } from './_commands';

/** Every string of the live section lives under one namespace of the participants locale file. */
const L = 'adminParticipants.verification.live';
const checkName = (check: string) => tDynamic(`${L}.checks.${check}`, check);
const stateTone = (state: string) => (state === 'active' ? 'pass' : state === 'draft' ? 'warn' : 'neutral');
const stateName = (state: string) => tDynamic(`${L}.states.${state}`, state);
const modeName = (mode: string) => tDynamic(`${L}.modes.${mode}`, mode);

function RecipeSteps({ recipe }: { recipe: VerificationRecipe }) {
  return (
    <ol className="admin-ordered">
      {recipe.steps.map((step) => ('check' in step ? (
        <li key={step.check}>
          {checkName(step.check)} · {t(step.required ? 'adminParticipants.verification.live.recipes.required' : 'adminParticipants.verification.live.recipes.optional')}
        </li>
      ) : (
        <li key={step.anyOf.join('+')}>{t('adminParticipants.verification.live.recipes.anyOf', { checks: step.anyOf.map(checkName).join(', ') })}</li>
      )))}
    </ol>
  );
}

function RecipeCard({ ctx, recipe, names }: { ctx: HubContext; recipe: VerificationRecipe; names: StaffNames }) {
  const canEdit = ctx.can('admin.claims.policy.edit');
  return (
    <li className="admin-approval" data-testid={`live-recipe-${recipe.key}-${recipe.version}`}>
      <div className="admin-panel__head">
        <h3 className="admin-h3">
          <code className="admin-code">{recipe.key}</code>
        </h3>
        <span className="admin-pill">{t('adminParticipants.common.version', { version: recipe.version })}</span>
        <Pill tone={stateTone(recipe.status)}>{stateName(recipe.status)}</Pill>
      </div>
      <p className="admin-meta">
        {tDynamic(`adminParticipants.subjects.${recipe.subjectKind}`, recipe.subjectKind)} · {tDynamic(`${L}.triggers.${recipe.trigger}`, recipe.trigger)} · {t('adminParticipants.verification.live.recipes.recheck', { months: recipe.recheckMonths })}
      </p>
      <RecipeSteps recipe={recipe} />
      <KeyValues
        rows={[
          { label: t('adminParticipants.verification.live.recipes.badges'), value: recipe.badgeCategories.map((c) => <code key={c} className="admin-code">{c} </code>) },
          { label: t('adminParticipants.verification.live.recipes.draftedBy'), value: <StaffName names={names} id={recipe.draftedBy} /> },
          ...(recipe.activatedBy && recipe.activatedAt ? [{ label: t('adminParticipants.verification.live.recipes.activatedBy'), value: <><StaffName names={names} id={recipe.activatedBy} /> · {longDate(recipe.activatedAt)}</> }] : []),
        ]}
      />
      {recipe.status === 'draft' ? (
        <ConsoleForm
          action={submitConsoleCommand}
          hidden={ctx.hidden('verification.recipe_activate', { 'f.recipeId': recipe.id, 'f.revision': String(recipe.revision) })}
          labels={formLabels({ submit: t('adminParticipants.verification.live.recipes.activate') })}
          disabledReason={readOnlyReason(canEdit, ctx.offline)}
        />
      ) : (
        <p>
          <a href={`${ctx.href('participants/verification', { from: recipe.id })}#recipe-draft`}>{t('adminParticipants.verification.live.recipes.newVersion')}</a>
        </p>
      )}
    </li>
  );
}

/** How a recipe uses a check, for the draft form started from an existing version. */
function usesOf(recipe: VerificationRecipe | undefined): Partial<Record<string, StepUse>> {
  const uses: Partial<Record<string, StepUse>> = {};
  for (const step of recipe?.steps ?? []) {
    if ('check' in step) uses[step.check] = step.required ? 'required' : 'optional';
    else for (const check of step.anyOf) uses[check] = 'any';
  }
  return uses;
}

function RecipeDraft({ ctx, from }: { ctx: HubContext; from: VerificationRecipe | undefined }) {
  const uses = usesOf(from);
  const options = (values: readonly string[], prefix: string) => values.map((value) => ({ value, label: tDynamic(`${prefix}.${value}`, value) }));
  return (
    <Panel id="recipe-draft" title={t('adminParticipants.verification.live.draft.title')}>
      <p className="admin-note">{t('adminParticipants.verification.live.draft.help')}</p>
      <ConsoleForm
        action={submitConsoleCommand}
        hidden={ctx.hidden('verification.recipe_draft')}
        labels={formLabels({ submit: t('adminParticipants.verification.live.draft.submit') })}
        disabledReason={readOnlyReason(ctx.can('admin.claims.policy.edit'), ctx.offline)}
      >
        <div className="admin-form__grid">
          <TextInput name="key" label={t('adminParticipants.verification.live.draft.key')} description={t('adminParticipants.verification.live.draft.keyHelp')} isRequired defaultValue={from?.key} />
          <SelectField name="subjectKind" label={t('adminParticipants.verification.live.draft.subject')} defaultValue={from?.subjectKind} options={options(VERIFICATION_SUBJECTS, 'adminParticipants.subjects')} />
          <SelectField name="trigger" label={t('adminParticipants.verification.live.draft.trigger')} defaultValue={from?.trigger} options={options(VERIFICATION_TRIGGERS, `${L}.triggers`)} />
          <TextInput name="recheckMonths" label={t('adminParticipants.verification.live.draft.recheckMonths')} description={t('adminParticipants.verification.live.draft.recheckHelp')} isRequired defaultValue={from ? String(from.recheckMonths) : '12'} />
          <TextInput name="categories" label={t('adminParticipants.verification.live.draft.badges')} description={t('adminParticipants.verification.live.draft.badgesHelp')} isRequired defaultValue={from?.badgeCategories.join(', ')} />
        </div>
        <FieldGroup legend={t('adminParticipants.verification.live.draft.steps')}>
          <p className="admin-note">{t('adminParticipants.verification.live.draft.anyHelp')}</p>
          <div className="admin-form__grid">
            {CHOOSABLE_CHECKS.map((check) => (
              <SelectField key={check} name={`step.${check}`} label={checkName(check)} defaultValue={uses[check] ?? 'off'} options={STEP_USES.map((use) => ({ value: use, label: tDynamic(`${L}.draft.uses.${use}`, use) }))} />
            ))}
          </div>
          <p className="admin-note" data-testid="sanctions-fixed">{t('adminParticipants.verification.screeningAlwaysOn')}</p>
        </FieldGroup>
      </ConsoleForm>
    </Panel>
  );
}

function credentialName(credential: VerificationCredential | undefined, id: string) {
  return credential ? `${credential.provider} · ${credential.adapter} · ${modeName(credential.mode)}` : id;
}

/** The stage of one provider and credential: ask a second person, wait for them, or finish with the approval. */
function GoLiveRow({ ctx, provider, option, credential, names }: { ctx: HubContext; provider: VerificationProvider; option: LiveOption; credential: VerificationCredential | undefined; names: StaffNames }) {
  const fields = { 'f.providerId': provider.id, 'f.credentialRefId': option.credentialId };
  const { stage } = option;
  return (
    <li data-testid={`go-live-${provider.id}-${option.credentialId}`}>
      <p>
        {credentialName(credential, option.credentialId)} · <span className="admin-meta">{t('adminParticipants.verification.live.goLive.digest')} <code className="admin-code">{option.digest.slice(0, 12)}</code></span>
      </p>
      {stage.stage === 'none' ? (
        <ConsoleForm
          action={submitConsoleCommand}
          hidden={ctx.hidden('verification.provider_request_live', fields)}
          labels={formLabels({ submit: t('adminParticipants.verification.live.goLive.ask'), secondPerson: true })}
          disabledReason={readOnlyReason(ctx.can('admin.providers.toggle'), ctx.offline)}
          submitVariant="secondary"
        />
      ) : stage.stage === 'approved' ? (
        <ConsoleForm
          action={submitConsoleCommand}
          hidden={ctx.hidden('verification.provider_go_live', fields)}
          labels={formLabels({ submit: t('adminParticipants.verification.live.goLive.apply') })}
          disabledReason={readOnlyReason(ctx.can('admin.claims.policy.edit'), ctx.offline)}
        />
      ) : (
        <p className="admin-note">
          {t(stage.approved ? 'adminParticipants.verification.live.goLive.approvedForOther' : 'adminParticipants.verification.live.goLive.waiting')} · <StaffName names={names} id={stage.requestedBy} /> ·{' '}
          <a href={ctx.href('approvals')}>{t('adminParticipants.verification.live.goLive.openApprovals')}</a>
        </p>
      )}
    </li>
  );
}

function Providers({ ctx, view, names }: { ctx: HubContext; view: VerificationView; names: StaffNames }) {
  const money = (minor: string | null) => (minor === null ? t('adminParticipants.verification.live.providers.noCost') : t('adminParticipants.verification.live.providers.costMinor', { minor }));
  const pending = view.providers.filter((p) => p.status === 'active' && p.mode !== 'live');
  return (
    <>
      <Panel id="providers" title={t('adminParticipants.verification.checks')}>
        <Table
          testid="live-providers"
          rows={view.providers}
          rowKey={(p) => p.id}
          empty={t('adminParticipants.verification.noChecks')}
          columns={[
            { label: t('adminParticipants.verification.check'), render: (p) => <>{checkName(p.checkType)}<div className="admin-meta"><code className="admin-code">{p.adapter}</code></div></> },
            { label: t('adminParticipants.verification.mode'), render: (p) => <><Pill tone={p.mode === 'live' ? 'pass' : 'neutral'}>{modeName(p.mode)}</Pill> {p.status === 'active' ? null : <Pill tone="neutral">{stateName(p.status)}</Pill>}</> },
            { label: t('adminParticipants.verification.retentionAndBasis'), render: (p) => <>{t('adminParticipants.verification.days', { days: p.retentionDays })}<div className="admin-meta">{tDynamic(`${L}.legalBases.${p.legalBasis}`, p.legalBasis)}</div></> },
            { label: t('adminParticipants.verification.live.providers.cost'), render: (p) => money(p.costMinor) },
          ]}
        />
        <p className="admin-note">{t('adminParticipants.verification.costNote')}</p>
      </Panel>
      {pending.length ? (
        <Panel id="go-live" title={t('adminParticipants.verification.live.goLive.title')}>
          <p className="admin-note">{t('adminParticipants.verification.liveNote')}</p>
          {view.credentials === null ? <p className="admin-empty">{t('adminParticipants.verification.live.goLive.credentialsHidden')}</p> : null}
          {pending.map((provider) => {
            const options = view.liveOptions[provider.id] ?? [];
            return (
              <div key={provider.id} className="admin-subsection">
                <h3 className="admin-h3">
                  {checkName(provider.checkType)} · <code className="admin-code">{provider.adapter}</code>
                </h3>
                {options.length ? (
                  <ul className="admin-list">
                    {options.map((option) => (
                      <GoLiveRow key={option.credentialId} ctx={ctx} provider={provider} option={option} credential={view.credentials?.find((c) => c.id === option.credentialId)} names={names} />
                    ))}
                  </ul>
                ) : view.credentials !== null ? (
                  <p className="admin-empty">{t('adminParticipants.verification.live.goLive.noCredentials')}</p>
                ) : null}
              </div>
            );
          })}
        </Panel>
      ) : null}
      <Panel id="provider-register" title={t('adminParticipants.verification.live.providers.register')}>
        <ConsoleForm
          action={submitConsoleCommand}
          hidden={ctx.hidden('verification.provider_register')}
          labels={formLabels({ submit: t('adminParticipants.verification.live.providers.register') })}
          disabledReason={readOnlyReason(ctx.can('admin.claims.policy.edit'), ctx.offline)}
        >
          <div className="admin-form__grid">
            <SelectField name="checkType" label={t('adminParticipants.verification.check')} options={CHOOSABLE_CHECKS.map((c) => ({ value: c, label: checkName(c) }))} />
            <TextInput name="adapter" label={t('adminParticipants.verification.live.providers.adapter')} description={t('adminParticipants.verification.live.providers.adapterHelp')} isRequired />
            <SelectField name="mode" label={t('adminParticipants.verification.mode')} options={REGISTERED_PROVIDER_MODES.map((m) => ({ value: m, label: modeName(m) }))} description={t('adminParticipants.verification.liveNote')} />
            <TextInput name="retentionDays" label={t('adminParticipants.verification.live.providers.retentionDays')} isRequired defaultValue="365" />
            <SelectField name="legalBasis" label={t('adminParticipants.verification.live.providers.legalBasis')} options={VERIFICATION_LEGAL_BASES.map((b) => ({ value: b, label: tDynamic(`${L}.legalBases.${b}`, b) }))} />
            <TextInput name="costMinor" label={t('adminParticipants.verification.live.providers.costField')} description={t('adminParticipants.verification.live.providers.costHelp')} />
          </div>
        </ConsoleForm>
      </Panel>
    </>
  );
}

function LaunchRecord({ ctx, view }: { ctx: HubContext; view: VerificationView }) {
  const running = activeRecipes(view.recipes);
  const state = view.config === null ? 'missing' : view.config.current ? 'current' : 'outdated';
  const canRecord = ctx.can('admin.claims.policy.edit') || ctx.can('admin.config.edit');
  return (
    <Panel id="launch-record" title={t('adminParticipants.verification.live.launch.title')} aside={<Pill tone={state === 'current' ? 'pass' : 'warn'}>{t(`adminParticipants.verification.live.launch.state.${state}`)}</Pill>}>
      <p className="admin-note" data-testid="launch-record-state">
        {view.config ? t('adminParticipants.verification.live.launch.version', { version: view.config.version }) : t('adminParticipants.verification.live.launch.none')}
      </p>
      <p className="admin-note">{t('adminParticipants.verification.live.launch.help')}</p>
      {running.length === 0 ? (
        <p className="admin-empty">{t('adminParticipants.verification.live.launch.noActive')}</p>
      ) : state === 'current' ? null : (
        <ConsoleForm action={submitConsoleCommand} hidden={ctx.hidden('verification.config_record')} labels={formLabels({ submit: t('adminParticipants.verification.live.launch.record') })} disabledReason={readOnlyReason(canRecord, ctx.offline)} />
      )}
    </Panel>
  );
}

function ClaimPeriods({ ctx, settings }: { ctx: HubContext; settings: NonNullable<VerificationView['settings']> }) {
  return (
    <Panel id="claim-periods" title={t('adminParticipants.verification.live.claims.title')}>
      <p className="admin-note">{t('adminParticipants.verification.live.claims.help')}</p>
      <ConsoleForm
        action={submitConsoleCommand}
        hidden={ctx.hidden('verification.claim_settings')}
        labels={formLabels({ submit: t('adminParticipants.verification.live.claims.save') })}
        disabledReason={readOnlyReason(ctx.can('admin.claims.policy.edit'), ctx.offline)}
      >
        <div className="admin-form__grid">
          <TextInput name="waitingDays" label={t('adminParticipants.verification.live.claims.waitingDays')} description={t('adminParticipants.verification.live.claims.waitingHelp')} isRequired defaultValue={String(settings.waitingDays)} />
          <TextInput name="coolingDays" label={t('adminParticipants.verification.live.claims.coolingDays')} description={t('adminParticipants.verification.live.claims.coolingHelp')} isRequired defaultValue={String(settings.coolingDays)} />
        </div>
      </ConsoleForm>
    </Panel>
  );
}

function ScreeningLists({ ctx, lists }: { ctx: HubContext; lists: NonNullable<VerificationView['lists']> }) {
  const age = (seconds: number | null) => (seconds === null ? t('adminParticipants.verification.live.lists.noAge') : t('adminParticipants.verification.days', { days: Math.floor(seconds / 86_400) }));
  return (
    <Panel id="screening-lists" title={t('adminParticipants.verification.lists')}>
      <Table
        testid="live-screening-lists"
        rows={lists}
        rowKey={(l) => l.code}
        empty={t('adminParticipants.verification.noLists')}
        columns={[
          { label: t('adminParticipants.verification.list'), render: (l) => <code className="admin-code">{l.code}</code> },
          { label: t('adminParticipants.verification.kind'), render: (l) => (l.baseline ? <strong>{t('adminParticipants.verification.baselineAlwaysOn')}</strong> : t('adminParticipants.verification.additional')) },
          { label: t('adminParticipants.verification.mode'), render: (l) => tDynamic(`adminParticipants.modes.${l.mode}`, l.mode) },
          { label: t('adminParticipants.verification.live.lists.age'), render: (l) => age(l.freshness.ageSeconds) },
        ]}
      />
      <p className="admin-note">
        {t('adminParticipants.verification.live.lists.note')} <a href={ctx.href('trust/screening')}>{t('adminParticipants.verification.live.lists.open')}</a>
      </p>
    </Panel>
  );
}

/**
 * HC-23 on the API (HUBC-007): the same section as the demo screen, on what HUB-003 and CLM-001 really hold. A value the
 * viewer may not read is said to be hidden, never shown as empty.
 */
export async function LiveVerification(ctx: HubContext, route: ScreenRoute) {
  const view = await ctx.port.verification(ctx.record.hub.id);
  const header = <ConsoleHeader ctx={ctx} title={t('adminParticipants.verification.title')} lede={t('adminParticipants.verification.lede')} />;
  if (!view) {
    return (
      <>
        {header}
        <p className="admin-empty">{t('adminParticipants.verification.live.hidden')}</p>
      </>
    );
  }
  const requesters = Object.values(view.liveOptions).flat().flatMap((o) => (o.stage.stage === 'requested' ? [o.stage.requestedBy] : []));
  const names = await staffNames(ctx, [...view.recipes.flatMap((r) => [r.draftedBy, r.activatedBy]), ...requesters]);
  const from = view.recipes.find((r) => r.id === route.query.from);
  return (
    <>
      {header}
      <LaunchRecord ctx={ctx} view={view} />
      <Panel id="recipes" title={t('adminParticipants.verification.recipes')}>
        {view.recipes.length ? (
          <ul className="admin-cards">
            {view.recipes.map((recipe) => (
              <RecipeCard key={recipe.id} ctx={ctx} recipe={recipe} names={names} />
            ))}
          </ul>
        ) : (
          <p className="admin-empty">{t('adminParticipants.verification.noRecipes')}</p>
        )}
      </Panel>
      <RecipeDraft ctx={ctx} from={from} />
      <Providers ctx={ctx} view={view} names={names} />
      {view.settings ? <ClaimPeriods ctx={ctx} settings={view.settings} /> : <p className="admin-empty">{t('adminParticipants.verification.live.claims.hidden')}</p>}
      {view.lists ? <ScreeningLists ctx={ctx} lists={view.lists} /> : <p className="admin-empty">{t('adminParticipants.verification.live.lists.hidden')}</p>}
    </>
  );
}
