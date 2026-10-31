'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Eye, EyeOff, MapPin } from 'lucide-react';
import { Switch } from '@trustwork/ui';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import { t } from '@/app/_lib/i18n';
import { regionLabel } from '@/app/_lib/country';
import { typo } from '@/app/_lib/typo';
import { StepFrame } from './StepFrame';
import { EMPTY_STATE, SIGNALS, completeness, loadOnboarding, saveOnboarding, type OnboardingState } from './onboarding-state';

/**
 * Step 4 «Ваша публичная страница»: publish on/off (off by default), portrait consent with the licence statement,
 * employer display, self-declared statuses; the live preview renders exactly what `/people/[slug]` would show.
 */
export function ProfileStep({ name, nextHref, backHref, skipHref }: { name: string; nextHref: string; backHref: string; skipHref: string }) {
  const router = useRouter();
  const [state, setState] = useState<OnboardingState>(EMPTY_STATE);
  useEffect(() => setState(loadOnboarding()), []);
  const patch = (p: Partial<OnboardingState>) => setState((s) => ({ ...s, ...p }));
  const save = () => {
    saveOnboarding(state);
    router.push(nextHref);
  };
  const roleLine = state.headline.trim() || (state.field ? t(`people.fieldOne.${state.field}` as 'people.fieldOne.management') : t('onboarding3.profile.previewRole'));
  const employer = state.employment === 'company' && state.showEmployer && state.company.trim() ? state.company.trim() : state.employment === 'independent' ? t('onboarding3.employment.independent') : null;

  const preview = (
    <div className="ob__preview" aria-label={t('onboarding3.profile.preview')}>
      <span className="ob__preview-kicker">
        {state.publish ? <Eye size={14} strokeWidth={2} aria-hidden="true" /> : <EyeOff size={14} strokeWidth={2} aria-hidden="true" />}
        {state.publish ? t('onboarding3.profile.previewPublic') : t('onboarding3.profile.previewHidden')}
      </span>
      <div className={`ob__card-person${state.publish ? '' : ' is-hidden'}`}>
        <PersonAvatar name={name} portrait={null} size={64} />
        <div className="ob__card-person-body">
          <strong>{name}</strong>
          <span>{typo(roleLine)}</span>
          {employer ? <span className="ob__card-person-emp">{typo(employer)}</span> : null}
          {state.regions.length ? (
            <span className="ob__card-person-region">
              <MapPin size={13} strokeWidth={2} aria-hidden="true" />
              {state.regions.map((r) => regionLabel(r)).join(', ')}
            </span>
          ) : null}
          {state.signals.length ? (
            <span className="ob__card-person-signals">
              {state.signals.map((s) => (
                <span key={s} className="sig">
                  {t(`signals.person.${s}` as 'signals.person.openToWork')}
                </span>
              ))}
            </span>
          ) : null}
          {state.topics.length ? <span className="ob__card-person-topics">{state.topics.map((tp) => t(`taxonomy.topics.${tp}` as 'taxonomy.topics.materials')).join(' · ')}</span> : null}
        </div>
      </div>
      <p className="ob__hint">{t('onboarding3.profile.portraitNote')}</p>
    </div>
  );

  return (
    <StepFrame
      title={t('onboarding3.profile.title')}
      lede={t('onboarding3.profile.lede')}
      completeness={completeness(state)}
      backHref={backHref}
      skipHref={skipHref}
      skipLabel={t('onboarding3.profile.later')}
      continueLabel={t('onboarding3.profile.finish')}
      onContinue={save}
      aside={preview}
    >
      <div className="ob__switches">
        <Switch isSelected={state.publish} onChange={(v) => patch({ publish: v })}>
          <strong>{t('onboarding3.profile.publish')}</strong>
          <span className="ob__switch-hint">{typo(t('onboarding3.profile.publishHint'))}</span>
        </Switch>
        <Switch isSelected={state.portraitConsent} onChange={(v) => patch({ portraitConsent: v })}>
          <strong>{t('onboarding3.profile.portrait')}</strong>
          <span className="ob__switch-hint">{typo(t('onboarding3.profile.portraitHint'))}</span>
        </Switch>
        {state.employment === 'company' ? (
          <Switch isSelected={state.showEmployer} onChange={(v) => patch({ showEmployer: v })}>
            <strong>{t('onboarding3.profile.employer')}</strong>
            <span className="ob__switch-hint">{typo(t('onboarding3.profile.employerHint'))}</span>
          </Switch>
        ) : null}
      </div>
      <fieldset className="ob__fieldset">
        <legend className="ob__legend">{t('onboarding3.profile.signals')}</legend>
        <p className="ob__hint">{typo(t('onboarding3.profile.signalsHint'))}</p>
        <div className="ob__chips">
          {SIGNALS.map((s) => {
            const on = state.signals.includes(s);
            return (
              <label key={s} className={`ob__chip${on ? ' is-on' : ''}`}>
                <input type="checkbox" className="ob__card-input" checked={on} onChange={() => patch({ signals: on ? state.signals.filter((x) => x !== s) : [...state.signals, s] })} />
                {on ? <Check size={14} strokeWidth={2.5} aria-hidden="true" /> : null}
                {t(`signals.person.${s}` as 'signals.person.openToWork')}
              </label>
            );
          })}
        </div>
      </fieldset>
    </StepFrame>
  );
}
