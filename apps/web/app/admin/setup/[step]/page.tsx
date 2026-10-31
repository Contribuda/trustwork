import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { COUNTRIES, countryName, isRestricted, PACKS } from '@trustwork/country-packs';
import { PROVIDER_CAPABILITIES, SETUP_STEPS } from '@trustwork/contracts/client';
import { PasswordField, Stepper, TextField } from '@/components/ui';
import { currentLocale, t, tDynamic } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import { submitConsoleCommand } from '../../_data/actions';
import type { ConsoleRequest } from '../../_data/personas';
import type { SetupRun } from '../../_data/schemas';
import { ConsoleForm } from '../../_components/ConsoleForm';
import { consoleRequest, type PageSearchParams } from '../../_components/context';
import { SelectField, TextInput } from '../../_components/forms';
import { AdminShell, KeyValues, Panel, StatusLabel } from '../../_components/shell';
import { setupHref, STEP_SLUGS, stepFromSlug, type SetupStep } from '../steps';

type Params = Promise<{ step: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  await primeLocale();
  const step = stepFromSlug((await params).step);
  return { title: step ? t('admin.setup.title') + ' · ' + tDynamic(`admin.setup.${STEP_SLUGS[step]}.title`, step) : t('error.notFoundTitle') };
}

const INSTALL_GUIDE = 'https://github.com/Contribuda/trustwork/blob/main/docs/engine/hub-console/installation.md';
const SETUP_CAPABILITIES = ['llm', 'email', 'sms', 'payments', 'maps_geocoding', 'register_lookup', 'e_signature', 'tax_calculation'] as const satisfies readonly (typeof PROVIDER_CAPABILITIES)[number][];

/** "Start from an example": synthetic values marked as examples, for the US reference hub or the Samarkand example. */
const EXAMPLES = {
  us: { territory: 'US-CA:san-diego', name: 'Trustwork United States (example)', languages: 'en, es', currency: 'USD', timeZone: 'America/Los_Angeles', pack: 'US' },
  samarkand: { territory: 'UZ-SA:samarkand', name: 'Trustwork Samarqand (namuna)', languages: 'uz-Latn, ru', currency: 'UZS', timeZone: 'Asia/Samarkand', pack: 'UZ' },
} as const;

function countryOptions(): Array<{ value: string; label: string }> {
  const locale = currentLocale();
  const collator = new Intl.Collator(locale);
  const countries = COUNTRIES.filter((c) => !isRestricted(c.code))
    .map((c) => ({ value: c.code, label: countryName(c.code, locale) }))
    .sort((a, b) => collator.compare(a.label, b.label));
  // No country is preselected (ADR 012 decision 11): the operator chooses, or an example fills it in.
  return [{ value: '', label: t('admin.setup.chooseCountry') }, ...countries];
}

function StepBody({ step, run, example }: { step: SetupStep; run: SetupRun; example: (typeof EXAMPLES)[keyof typeof EXAMPLES] | null }) {
  switch (step) {
    case 'install_check':
      return (
        <>
          <ul className="admin-checks">
            {run.checks.map((c) => (
              <li key={c.id} className={`admin-check admin-check--${c.state}`} data-testid={`check-${c.id}`}>
                <span className="admin-check__name">{t(`admin.setup.check.items.${c.id}`)}</span>
                <span className={`admin-pill admin-pill--${c.state}`}>{t(`admin.setup.check.states.${c.state}`)}</span>
                {c.state !== 'pass' ? <span className="admin-meta">{t(`admin.setup.check.help.${c.id}`)}</span> : null}
              </li>
            ))}
          </ul>
          {run.checks.some((c) => c.state === 'fail') ? (
            <p className="admin-callout admin-callout--danger" role="alert">
              {t('admin.setup.check.blocking')}{' '}
              <a href={INSTALL_GUIDE} rel="noopener noreferrer" target="_blank">
                {t('admin.setup.check.guide')}
                <span className="admin-visually-hidden"> {t('admin.common.opensNewTab')}</span>
              </a>
            </p>
          ) : null}
        </>
      );
    case 'node_identity':
      return (
        <>
          <TextInput name="nodeName" label={t('admin.setup.node.name')} isRequired />
          <TextInput name="domain" label={t('admin.setup.node.domain')} description={t('admin.setup.node.domainHelp')} isRequired />
          <SelectField name="jurisdiction" label={t('admin.setup.node.jurisdiction')} description={t('admin.setup.node.jurisdictionHelp')} options={countryOptions()} />
          <p className="admin-note">{t('admin.setup.node.key')}</p>
        </>
      );
    case 'hub_identity':
      return (
        <>
          <SelectField
            name="pack"
            label={t('admin.setup.hub.start')}
            defaultValue={example?.pack ?? 'generic'}
            options={[...PACKS.filter((p) => p.enabled).map((p) => ({ value: p.code, label: t('admin.setup.hub.pack', { country: countryName(p.code, currentLocale()) }) })), { value: 'generic', label: t('admin.setup.hub.generic') }]}
            description={t('admin.setup.hub.startHelp')}
          />
          <TextInput name="territory" label={t('admin.setup.hub.territory')} description={t('admin.setup.hub.territoryHelp')} isRequired defaultValue={example?.territory} />
          <TextInput name="name" label={t('admin.setup.hub.name')} description={t('admin.setup.hub.nameHelp')} isRequired defaultValue={example?.name} />
          <TextInput name="languages" label={t('admin.setup.hub.languages')} description={t('admin.setup.hub.languagesHelp')} isRequired defaultValue={example?.languages} />
          <div className="admin-form__grid">
            <TextInput name="currency" label={t('admin.setup.hub.currency')} isRequired defaultValue={example?.currency} />
            <TextInput name="timeZone" label={t('admin.setup.hub.timeZone')} isRequired defaultValue={example?.timeZone} />
          </div>
          {example ? <p className="admin-callout">{t('admin.setup.hub.exampleNote')}</p> : null}
        </>
      );
    case 'operator':
      return (
        <>
          <TextInput name="legalName" label={t('admin.setup.operator.legalName')} isRequired />
          <SelectField
            name="form"
            label={t('admin.setup.operator.form')}
            options={(['llc', 'corporation', 'nonprofit_association', 'sole_proprietor', 'limited_company'] as const).map((f) => ({ value: f, label: t(`admin.hub.legal.forms.${f}`) }))}
          />
          <TextInput name="identifier" label={t('admin.setup.operator.identifier')} isRequired />
          <TextInput name="address" label={t('admin.setup.operator.address')} isRequired />
          <div className="admin-form__grid">
            <TextInput name="legalContact" label={t('admin.setup.operator.legalContact')} isRequired />
            <TextInput name="abuseContact" label={t('admin.setup.operator.abuseContact')} isRequired />
          </div>
          <label className="admin-check-input">
            <input type="checkbox" name="f.ownership" value="on" required /> {t('admin.setup.operator.ownership')}
          </label>
          <p className="admin-note">{t('admin.setup.operator.screening')}</p>
        </>
      );
    case 'first_admin':
      return (
        <>
          <div className="admin-form__grid">
            <TextField label={t('admin.setup.admin.name')} isRequired autoComplete="name" />
            <TextField label={t('admin.setup.admin.email')} isRequired type="email" autoComplete="email" />
          </div>
          <PasswordField label={t('admin.setup.admin.password')} autoComplete="new-password" description={t('admin.setup.admin.passwordHelp')} />
          <SelectField
            name="secondFactor"
            label={t('admin.setup.admin.secondFactor')}
            options={[
              { value: '', label: t('admin.setup.admin.chooseFactor') },
              { value: 'webauthn', label: t('admin.setup.admin.passkey') },
              { value: 'totp', label: t('admin.setup.admin.totp') },
            ]}
            description={t('admin.setup.admin.secondFactorHelp')}
          />
          <p className="admin-note">{t('admin.setup.admin.recoveryCodes')}</p>
          <label className="admin-check-input">
            <input type="checkbox" name="f.recoveryStored" value="on" /> {t('admin.setup.admin.stored')}
          </label>
          <p className="admin-note">{t('admin.setup.admin.reducedSod')}</p>
        </>
      );
    case 'storage_residency':
      return (
        <>
          <SelectField name="residencyCountry" label={t('admin.setup.residency.country')} description={t('admin.setup.residency.countryHelp')} options={countryOptions()} {...(example ? { defaultValue: example.pack } : {})} />
          <SelectField
            name="regime"
            label={t('admin.setup.residency.regime')}
            options={(['us_state_privacy', 'uz_personal_data', 'not_recorded'] as const).map((r) => ({ value: r, label: t(`admin.hub.residency.regimes.${r}`) }))}
          />
          <p className="admin-note">{t('admin.setup.residency.egress')}</p>
        </>
      );
    case 'providers':
      return (
        <>
          <div className="admin-form__grid">
            {SETUP_CAPABILITIES.map((c) => (
              <SelectField
                key={c}
                name={`provider.${c}`}
                label={t(`admin.capabilities.${c}`)}
                options={(['fake', 'manual', 'later'] as const).map((o) => ({ value: o, label: t(`admin.setup.providers.options.${o}`) }))}
              />
            ))}
          </div>
          <p className="admin-note">{t('admin.setup.providers.liveLater')}</p>
          <p className="admin-note">{t('admin.setup.providers.models')}</p>
          <p className="admin-note">{t('admin.setup.providers.invite')}</p>
        </>
      );
    case 'modes':
      return (
        <>
          <SelectField
            name="dataMode"
            label={t('admin.hub.modes.data')}
            options={[
              { value: 'demo', label: t('admin.hub.modes.dataMode.demo') },
              { value: 'live', label: t('admin.hub.modes.dataMode.live') },
            ]}
          />
          <KeyValues
            rows={[
              { label: t('admin.hub.modes.registration'), value: t('admin.hub.modes.registrationMode.closed') },
              { label: t('admin.hub.modes.moderation'), value: t('admin.hub.modes.moderationMode.pre_moderate_new_authors') },
              { label: t('admin.hub.modes.automation'), value: t('admin.values.automation.manual') },
              { label: t('admin.hub.modes.indexing'), value: t('admin.common.off') },
            ]}
          />
          <p className="admin-note">{t('admin.setup.modes.defaults')}</p>
        </>
      );
    case 'review':
      return null;
  }
}

function Review({ run, token }: { run: SetupRun; token: string }) {
  return (
    <>
      <ul className="admin-list" data-testid="setup-summary">
        {SETUP_STEPS.filter((s) => s !== 'review').map((s) => (
          <li key={s} className="admin-list__row">
            <span>{t(`admin.setup.${STEP_SLUGS[s]}.title`)}</span>
            <span className={`admin-pill admin-pill--${run.state.completed.includes(s) ? 'passed' : 'open'}`}>{t(run.state.completed.includes(s) ? 'admin.setup.review.done' : 'admin.setup.review.notDone')}</span>
            <a href={setupHref(s, token)}>
              {t('admin.setup.review.edit')}
              <span className="admin-visually-hidden"> {t(`admin.setup.${STEP_SLUGS[s]}.title`)}</span>
            </a>
          </li>
        ))}
      </ul>
      <h2 className="admin-h2">{t('admin.overview.nextFive')}</h2>
      <ol className="admin-ordered">
        {(['inviteStaff', 'legalDocuments', 'firstSource', 'verificationRecipe', 'backupDrill'] as const).map((k) => (
          <li key={k}>{t(`admin.overview.next.${k}`)}</li>
        ))}
      </ol>
      <p className="admin-note">{t('admin.setup.review.afterFinish')}</p>
    </>
  );
}

/**
 * The setup wizard (screens.md SW-1 … SW-9, setup-wizard.md): opened only with a valid one-time token, never after
 * setup finished, and never ahead of the first incomplete step. A minimal shell without navigation. In demo mode the
 * answers are validated by the same command evaluation and nothing is stored.
 */
export default async function SetupStepPage({ params, searchParams }: { params: Params; searchParams: PageSearchParams }) {
  await primeLocale();
  const query = await searchParams;
  const token = typeof query.token === 'string' ? query.token : '';
  const { port, demo } = await consoleRequest(searchParams);
  const run = token ? await port.setup(token) : null;
  if (!run) notFound();
  const step = stepFromSlug((await params).step);
  if (!step) notFound();
  const index = SETUP_STEPS.indexOf(step);
  if (index > SETUP_STEPS.indexOf(run.state.current)) redirect(setupHref(run.state.current, token));
  const next = SETUP_STEPS[index + 1];
  const exampleKey = query.example === 'us' || query.example === 'samarkand' ? query.example : null;
  const blocked = step === 'install_check' && run.checks.some((c) => c.state === 'fail');
  const request: ConsoleRequest = demo ? { demo: true, persona: null, scenario: 'default' } : { demo: false };
  const slug = STEP_SLUGS[step];
  return (
    <AdminShell request={request} hub={null} viewer={null} roles={[]} nav={null} current={null} navHref={(p) => p} helpHref={null} selfPath={`/admin/setup/${slug}`} showPersonas={false} label={t('admin.setup.title')}>
      <div className="admin-wizard">
        <Stepper steps={SETUP_STEPS.map((s) => ({ id: s, label: t(`admin.setup.${STEP_SLUGS[s]}.title`) }))} current={index + 1} label={t('admin.setup.stepsLabel')} />
        <header className="admin-head">
          <div className="admin-head__row">
            <h1 tabIndex={-1} className="admin-h1">
              {t(`admin.setup.${slug}.title`)}
            </h1>
            <StatusLabel status="demo" />
          </div>
          <p className="admin-lede">{t(`admin.setup.${slug}.purpose`)}</p>
        </header>
        <p className="admin-meta">{t('admin.setup.resume')}</p>
        {step === 'hub_identity' ? (
          <p className="admin-examples">
            {t('admin.setup.hub.examples')} <a href={setupHref(step, token, { example: 'us' })}>{t('admin.setup.hub.exampleUs')}</a> · <a href={setupHref(step, token, { example: 'samarkand' })}>{t('admin.setup.hub.exampleSamarkand')}</a>
          </p>
        ) : null}
        <Panel id="setup-step" title={t('admin.setup.answers')}>
          {step === 'review' ? <Review run={run} token={token} /> : null}
          <ConsoleForm
            action={submitConsoleCommand}
            hidden={{ command: 'setup.save', token, 'f.step': step }}
            labels={{ submit: step === 'review' ? t('admin.setup.finish') : t('admin.setup.continue') }}
            withReason={false}
            disabledReason={blocked ? t('admin.setup.check.cannotContinue') : null}
            {...(next ? { nextHref: setupHref(next, token) } : {})}
          >
            <StepBody step={step} run={run} example={exampleKey ? EXAMPLES[exampleKey] : null} />
          </ConsoleForm>
        </Panel>
      </div>
    </AdminShell>
  );
}
