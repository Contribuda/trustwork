import { notFound, redirect } from 'next/navigation';
import { COUNTRIES, countryName, isRestricted, PACKS } from '@trustwork/country-packs';
import { SETUP_STEPS } from '@trustwork/contracts/client';
import { PasswordField, Stepper, TextField } from '@/components/ui';
import { currentLocale, t, tDynamic } from '@/app/_lib/i18n';
import { SelectField, TextInput } from '../../_components/forms';
import { AdminShell, KeyValues, Panel, StatusLabel } from '../../_components/shell';
import { setupHref, STEP_SLUGS, type SetupStep } from '../steps';
import type { SetupView } from '../../../../../../packages/contracts/src/hub-setup.js';
import { LiveSetupForm, type LiveFormLabels } from './LiveSetupForm';
import { SETUP_PROVIDER_FIELDS } from './answers';

type Answers = Record<string, unknown>;
/** Provider names are names, not product copy: shown as they are in every language. */
const MODEL_PROVIDER_NAMES = { openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', mistral: 'Mistral' } as const;
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const answer = (view: SetupView, step: SetupStep): Answers => ((view.answers as Record<string, unknown>)[step] as Answers | undefined) ?? {};

const REASONS = [
  'restricted_place', 'step_out_of_order', 'install_check_failed', 'jurisdiction_unknown', 'jurisdiction_not_selectable', 'pack_unknown', 'time_zone_unknown', 'modes_violation',
  'node_fixed', 'first_admin_only', 'admin_account_mismatch', 'first_admin_bound', 'second_factor_required', 'second_factor_unavailable', 'jurisdiction_gate_unconfigured',
  'jurisdiction_gate_mismatch', 'attestation_invalid', 'attestation_required', 'payload_invalid', 'elevation', 'access.not_found', 'auth.session_invalid', 'auth.invalid_credentials',
  'auth.throttled', 'validation.schema', 'validation.unknown_field', 'network',
] as const;

function labels(submit: string, success?: string): LiveFormLabels {
  return {
    submit,
    generic: t('setupWizard.generic'),
    items: t('setupWizard.items'),
    reasons: Object.fromEntries(REASONS.map((r) => [r, tDynamic(`setupWizard.reasons.${r}`, t('setupWizard.generic'))])),
    ...(success ? { success } : {}),
  };
}

function countryOptions(): Array<{ value: string; label: string }> {
  const locale = currentLocale();
  const collator = new Intl.Collator(locale);
  const countries = COUNTRIES.filter((c) => !isRestricted(c.code)).map((c) => ({ value: c.code, label: countryName(c.code, locale) })).sort((a, b) => collator.compare(a.label, b.label));
  // No country is preselected (ADR 012 decision 11).
  return [{ value: '', label: t('setupWizard.chooseCountry') }, ...countries];
}

function StepFields({ step, view }: { step: SetupStep; view: SetupView }) {
  const a = answer(view, step);
  switch (step) {
    case 'install_check':
      return (
        <ul className="admin-checks">
          {view.checks.map((c) => (
            <li key={c.id} className={`admin-check admin-check--${c.state}`} data-testid={`check-${c.id}`}>
              <span className="admin-check__name">{tDynamic(`admin.setup.check.items.${c.id}`, c.id)}</span>
              <span className={`admin-pill admin-pill--${c.state}`}>{tDynamic(`admin.setup.check.states.${c.state}`, c.state)}</span>
              {c.reason ? <span className="admin-meta">{tDynamic(`setupWizard.checkReasons.${c.reason}`, c.reason)}</span> : null}
            </li>
          ))}
        </ul>
      );
    case 'node_identity':
      return (
        <>
          <TextInput name="nodeName" label={t('admin.setup.node.name')} isRequired defaultValue={str(a.nodeName)} />
          <TextInput name="domain" label={t('admin.setup.node.domain')} description={t('admin.setup.node.domainHelp')} isRequired defaultValue={str(a.domain)} />
          <SelectField name="jurisdiction" label={t('admin.setup.node.jurisdiction')} description={t('admin.setup.node.jurisdictionHelp')} options={countryOptions()} defaultValue={str(a.jurisdiction)} />
        </>
      );
    case 'hub_identity': {
      const territories = Array.isArray(a.territories) ? (a.territories as Array<{ code: string }>).map((x) => x.code).join(', ') : undefined;
      const locales = Array.isArray(a.locales) ? (a.locales as string[]).join(', ') : undefined;
      const name = a.name && typeof a.name === 'object' ? Object.values(a.name as Record<string, string>)[0] : undefined;
      return (
        <>
          <SelectField name="country" label={t('setupWizard.hub.country')} description={t('setupWizard.hub.countryHelp')} options={countryOptions()} defaultValue={str(a.country)} />
          <SelectField
            name="startingPoint"
            label={t('admin.setup.hub.start')}
            description={t('admin.setup.hub.startHelp')}
            defaultValue={str(a.startingPoint) ?? 'generic'}
            options={[{ value: 'generic', label: t('admin.setup.hub.generic') }, { value: 'pack', label: t('admin.setup.hub.pack', { country: PACKS.filter((p) => p.enabled).map((p) => countryName(p.code, currentLocale())).join(', ') }) }]}
          />
          <TextInput name="territories" label={t('setupWizard.hub.territories')} description={t('setupWizard.hub.territoriesHelp')} isRequired defaultValue={territories} />
          <TextInput name="name" label={t('admin.setup.hub.name')} description={t('setupWizard.hub.nameHelp')} isRequired defaultValue={name} />
          <TextInput name="languages" label={t('admin.setup.hub.languages')} description={t('setupWizard.hub.languagesHelp')} isRequired defaultValue={locales} />
          <div className="admin-form__grid">
            <TextInput name="currency" label={t('admin.setup.hub.currency')} isRequired defaultValue={str(a.currency)} />
            <TextInput name="timeZone" label={t('admin.setup.hub.timeZone')} isRequired defaultValue={str(a.timeZone)} />
          </div>
          <TextInput name="slug" label={t('setupWizard.hub.slug')} description={t('setupWizard.hub.slugHelp')} defaultValue={str(a.slug)} />
        </>
      );
    }
    case 'operator': {
      const screening = view.operatorScreening;
      return (
        <>
          <TextInput name="legalName" label={t('admin.setup.operator.legalName')} isRequired defaultValue={str(a.legalName)} />
          <SelectField
            name="form"
            label={t('admin.setup.operator.form')}
            defaultValue={str(a.form)}
            options={(['llc', 'corporation', 'nonprofit_association', 'sole_proprietor', 'limited_company'] as const).map((f) => ({ value: f, label: t(`admin.hub.legal.forms.${f}`) }))}
          />
          <TextInput name="identifier" label={t('admin.setup.operator.identifier')} isRequired defaultValue={str(a.identifier)} />
          <TextInput name="address" label={t('admin.setup.operator.address')} isRequired defaultValue={str(a.address)} />
          <div className="admin-form__grid">
            <TextInput name="legalContact" label={t('admin.setup.operator.legalContact')} isRequired defaultValue={str(a.legalContact)} />
            <TextInput name="abuseContact" label={t('admin.setup.operator.abuseContact')} isRequired defaultValue={str(a.abuseContact)} />
          </div>
          <label className="admin-check-input">
            <input type="checkbox" name="f.ownership" value="on" required defaultChecked={a.ownershipDeclared === true} /> {t('admin.setup.operator.ownership')}
          </label>
          <fieldset className="admin-fieldset">
            <legend>{t('setupWizard.operator.attestation')}</legend>
            <p className="admin-note">{t('setupWizard.operator.attestationHelp')}</p>
            <div className="admin-form__grid">
              <SelectField name="entityCountry" label={t('setupWizard.operator.entityCountry')} options={countryOptions()} defaultValue={str(a.entityCountry)} />
              <TextInput name="entityRegion" label={t('setupWizard.operator.entityRegion')} description={t('setupWizard.operator.regionHelp')} defaultValue={str(a.entityRegion)} />
              <SelectField name="hostingCountry" label={t('setupWizard.operator.hostingCountry')} options={countryOptions()} defaultValue={str(a.hostingCountry)} />
              <TextInput name="hostingRegion" label={t('setupWizard.operator.hostingRegion')} description={t('setupWizard.operator.regionHelp')} defaultValue={str(a.hostingRegion)} />
            </div>
            <SelectField
              name="gateMode"
              label={t('setupWizard.operator.gateMode')}
              defaultValue={str(a.gateMode)}
              options={(['upstream_gate', 'edge_header', 'ranges_file'] as const).map((m) => ({ value: m, label: t(`setupWizard.operator.gateModes.${m}`) }))}
            />
          </fieldset>
          <p className="admin-note">{t('admin.setup.operator.screening')}</p>
          {screening ? (
            <p className="admin-callout" data-testid="operator-screening">
              <strong>{t('setupWizard.operator.screening.title')}:</strong> {t(`setupWizard.operator.screening.${screening.outcome}`)}
              {screening.basis === 'fake' ? <> {t('setupWizard.operator.screening.fake')}</> : null}
            </p>
          ) : null}
        </>
      );
    }
    case 'storage_residency':
      return (
        <>
          <SelectField name="personalDataCountry" label={t('setupWizard.residency.personalDataCountry')} description={t('admin.setup.residency.countryHelp')} options={countryOptions()} defaultValue={str(a.personalDataCountry)} />
          <SelectField
            name="privacyRegime"
            label={t('admin.setup.residency.regime')}
            defaultValue={str(a.privacyRegime)}
            options={(['us_state_privacy', 'uz_personal_data', 'not_recorded'] as const).map((r) => ({ value: r, label: t(`admin.hub.residency.regimes.${r}`) }))}
          />
          <TextInput name="note" label={`${t('setupWizard.residency.note')} (${t('setupWizard.optional')})`} defaultValue={str(a.note)} />
          <p className="admin-note">{t('admin.setup.residency.egress')}</p>
        </>
      );
    case 'providers': {
      const caps = (a.capabilities ?? {}) as Record<string, string>;
      return (
        <>
          <div className="admin-form__grid">
            {SETUP_PROVIDER_FIELDS.map((c) => (
              <SelectField
                key={c}
                name={`provider.${c}`}
                label={t(`admin.capabilities.${c}`)}
                defaultValue={caps[c] ?? 'fake'}
                options={(c === 'llm' ? (['fake', 'later'] as const) : (['fake', 'manual', 'later'] as const)).map((o) => ({ value: o, label: t(`admin.setup.providers.options.${o}`) }))}
              />
            ))}
          </div>
          <div className="admin-form__grid">
            <SelectField
              name="models"
              label={t('setupWizard.providers.models')}
              description={t('admin.setup.providers.models')}
              defaultValue={str(a.models) ?? 'undecided'}
              options={(['undecided', 'openrouter', 'direct'] as const).map((m) => ({ value: m, label: t(`setupWizard.providers.modelOptions.${m}`) }))}
            />
            <SelectField
              name="directModelAdapter"
              label={t('setupWizard.providers.directAdapter')}
              defaultValue={str(a.directModelAdapter) ?? ''}
              options={[{ value: '', label: t('setupWizard.providers.adapterNone') }, ...Object.entries(MODEL_PROVIDER_NAMES).map(([value, label]) => ({ value, label })), { value: 'openai_compatible', label: t('setupWizard.providers.adapters.openai_compatible') }]}
            />
          </div>
          <p className="admin-note">{t('admin.setup.providers.liveLater')}</p>
          <p className="admin-note">{t('admin.setup.providers.invite')}</p>
        </>
      );
    }
    case 'modes':
      return (
        <>
          <SelectField
            name="dataMode"
            label={t('admin.hub.modes.data')}
            defaultValue={str(a.dataMode) ?? 'demo'}
            options={[{ value: 'demo', label: t('admin.hub.modes.dataMode.demo') }, { value: 'live', label: t('admin.hub.modes.dataMode.live') }]}
          />
          <SelectField
            name="moderation"
            label={t('setupWizard.modes.moderation')}
            defaultValue={str(a.moderation) ?? 'pre_moderate_new_authors'}
            options={(['pre_moderate_new_authors', 'pre_moderate_all', 'post_moderate'] as const).map((m) => ({ value: m, label: t(`admin.hub.modes.moderationMode.${m}`) }))}
          />
          <KeyValues
            rows={[
              { label: t('admin.hub.modes.registration'), value: t('admin.hub.modes.registrationMode.closed') },
              { label: t('admin.hub.modes.automation'), value: t('admin.values.automation.manual') },
              { label: t('admin.hub.modes.indexing'), value: t('admin.common.off') },
            ]}
          />
          <p className="admin-note">{t('admin.setup.modes.defaults')}</p>
        </>
      );
    default:
      return null;
  }
}

function FirstAdmin({ view, token, next }: { view: SetupView; token: string; next: string }) {
  const here = setupHref('first_admin', token);
  const signIn = `/login?next=${encodeURIComponent(here)}`;
  return (
    <>
      <Panel id="setup-account" title={t('setupWizard.admin.accountTitle')}>
        <p className="admin-note">{t('setupWizard.admin.accountHelp')}</p>
        {view.adminAccount ? <p className="admin-callout" data-testid="admin-account">{t('setupWizard.admin.accountCreated', { email: view.adminAccount.maskedEmail })}</p> : null}
        {view.session.signedIn ? null : (
          <LiveSetupForm kind="account" step="first_admin" token={token} labels={labels(t('admin.setup.continue'), t('setupWizard.admin.accountSent'))}>
            <div className="admin-form__grid">
              <TextInput name="name" label={t('admin.setup.admin.name')} isRequired />
              <TextField name="f.email" label={t('admin.setup.admin.email')} isRequired type="email" autoComplete="email" />
            </div>
            <PasswordField name="f.password" label={t('admin.setup.admin.password')} autoComplete="new-password" isRequired />
          </LiveSetupForm>
        )}
      </Panel>
      <Panel id="setup-factor" title={t('setupWizard.admin.factorTitle')}>
        <p className="admin-note">{t('setupWizard.admin.factorHelp')}</p>
        {view.session.signedIn ? (
          <p className={`admin-callout${view.session.secondFactor ? '' : ' admin-callout--danger'}`} data-testid="factor-state">
            {t(view.session.secondFactor ? 'setupWizard.admin.factorOn' : 'setupWizard.admin.factorMissing')}{' '}
            {view.session.secondFactor ? null : <a href={`/app/settings#security`}>{t('setupWizard.admin.securitySettings')}</a>}
          </p>
        ) : (
          <p className="admin-callout">
            {t('setupWizard.admin.signedOut')} <a href={signIn}>{t('setupWizard.admin.signIn')}</a>
          </p>
        )}
      </Panel>
      <Panel id="setup-confirm" title={t('setupWizard.admin.confirmTitle')}>
        <p className="admin-note">{t('setupWizard.admin.confirmHelp')}</p>
        {view.state.firstAdmin && !view.session.isFirstAdmin ? <p className="admin-callout admin-callout--danger">{t('setupWizard.admin.notYou')}</p> : null}
        {view.session.isFirstAdmin ? <p className="admin-callout" data-testid="first-admin-bound">{t('setupWizard.admin.bound')}</p> : null}
        <LiveSetupForm kind="first_admin" step="first_admin" token={token} labels={labels(t('admin.setup.continue'))} nextHref={next}>
          <SelectField name="secondFactor" label={t('admin.setup.admin.secondFactor')} options={[{ value: 'totp', label: t('admin.setup.admin.totp') }]} description={t('admin.setup.admin.secondFactorHelp')} />
          <label className="admin-check-input">
            <input type="checkbox" name="f.recoveryStored" value="on" required defaultChecked={view.state.firstAdmin !== null} /> {t('admin.setup.admin.stored')}
          </label>
          <p className="admin-note">{t('admin.setup.admin.reducedSod')}</p>
        </LiveSetupForm>
      </Panel>
    </>
  );
}

function Review({ view, token }: { view: SetupView; token: string }) {
  return (
    <>
      <ul className="admin-list" data-testid="setup-summary">
        {SETUP_STEPS.filter((s) => s !== 'review').map((s) => (
          <li key={s} className="admin-list__row">
            <span>{t(`admin.setup.${STEP_SLUGS[s]}.title`)}</span>
            <span className={`admin-pill admin-pill--${view.state.completed.includes(s) ? 'passed' : 'open'}`}>{t(view.state.completed.includes(s) ? 'admin.setup.review.done' : 'admin.setup.review.notDone')}</span>
            <a href={setupHref(s, token)}>
              {t('admin.setup.review.edit')}
              <span className="admin-visually-hidden"> {t(`admin.setup.${STEP_SLUGS[s]}.title`)}</span>
            </a>
          </li>
        ))}
      </ul>
      <KeyValues rows={[{ label: t('setupWizard.review.attestation'), value: t(`setupWizard.review.states.${view.attestation.state}`) }]} />
      <h2 className="admin-h2">{t('admin.overview.nextFive')}</h2>
      <ol className="admin-ordered">
        {(['inviteStaff', 'legalDocuments', 'firstSource', 'verificationRecipe', 'backupDrill'] as const).map((k) => (
          <li key={k}>{t(`admin.overview.next.${k}`)}</li>
        ))}
      </ol>
      <p className="admin-note">{t('admin.setup.review.afterFinish')}</p>
      <h2 className="admin-h2">{t('setupWizard.review.confirmTitle')}</h2>
      <p className="admin-note">{t('setupWizard.review.confirmHelp')}</p>
      <LiveSetupForm kind="finish" step="review" token={token} labels={labels(t('admin.setup.finish'), t('setupWizard.review.finished'))}>
        <PasswordField name="f.password" label={t('setupWizard.review.password')} autoComplete="current-password" isRequired />
        <TextField name="f.code" label={t('setupWizard.review.code')} autoComplete="one-time-code" inputMode="numeric" isRequired />
      </LiveSetupForm>
    </>
  );
}

/**
 * The live setup wizard (HUB-004): the same nine steps and layout as the demo (screens.md SW-1 … SW-9), backed by
 * `/v1/setup`. The answers come from the server (resume with the same link); the wizard never skips ahead of the first
 * incomplete step; after setup finished, or without a valid token, every step is "not found".
 */
export async function LiveSetupPage({ step, token, view }: { step: SetupStep | null; token: string; view: SetupView | null }) {
  if (!view || !step) notFound();
  const index = SETUP_STEPS.indexOf(step);
  if (index > SETUP_STEPS.indexOf(view.state.current)) redirect(setupHref(view.state.current, token));
  const next = SETUP_STEPS[index + 1];
  const slug = STEP_SLUGS[step];
  const blocked = step === 'install_check' && view.checks.some((c) => c.state === 'fail');
  return (
    <AdminShell request={{ demo: false }} hub={null} viewer={null} roles={[]} nav={null} current={null} navHref={(p) => p} helpHref={null} selfPath={`/admin/setup/${slug}`} showPersonas={false} label={t('admin.setup.title')}>
      <div className="admin-wizard">
        <Stepper steps={SETUP_STEPS.map((s) => ({ id: s, label: t(`admin.setup.${STEP_SLUGS[s]}.title`) }))} current={index + 1} label={t('admin.setup.stepsLabel')} />
        <header className="admin-head">
          <div className="admin-head__row">
            <h1 tabIndex={-1} className="admin-h1">
              {t(`admin.setup.${slug}.title`)}
            </h1>
            <StatusLabel status="live" />
          </div>
          <p className="admin-lede">{t(`admin.setup.${slug}.purpose`)}</p>
        </header>
        <p className="admin-meta">{t('setupWizard.resume')}</p>
        {step === 'first_admin' ? (
          <FirstAdmin view={view} token={token} next={setupHref(next ?? 'review', token)} />
        ) : (
          <Panel id="setup-step" title={t('admin.setup.answers')}>
            {step === 'review' ? (
              <Review view={view} token={token} />
            ) : blocked ? (
              <>
                <StepFields step={step} view={view} />
                <p className="admin-callout admin-callout--danger" role="alert">
                  {t('admin.setup.check.blocking')}
                </p>
              </>
            ) : (
              <LiveSetupForm kind="step" step={step} token={token} labels={labels(t('admin.setup.continue'), t('setupWizard.saved'))} nextHref={next ? setupHref(next, token) : undefined}>
                <StepFields step={step} view={view} />
              </LiveSetupForm>
            )}
          </Panel>
        )}
      </div>
    </AdminShell>
  );
}
