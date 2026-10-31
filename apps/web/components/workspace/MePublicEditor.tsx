'use client';

import { useEffect, useState } from 'react';
import NextLink from 'next/link';
import { Check, Eye, EyeOff, MapPin } from 'lucide-react';
import { Button, Switch, TagSelect, TextField } from '@trustwork/ui';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import { EMPTY_STATE, SIGNALS, TOPICS, loadOnboardingWith, saveOnboarding, type OnboardingState } from '@/components/onboarding/onboarding-state';
import { t } from '@/app/_lib/i18n';
import { regionLabel } from '@/app/_lib/country';
import { typo } from '@/app/_lib/typo';

/**
 * Public projection editor: what `/people/[handle]` will show. Publish is off until the person turns it on; the
 * portrait needs explicit consent; the employer line is optional. Saves to the browser session in the demo.
 */
export function MePublicEditor({ name, roleLine, employer, publicHref, seed }: { name: string; roleLine: string; employer: string | null; publicHref: string | null; seed: Partial<OnboardingState> }) {
  const [state, setState] = useState<OnboardingState>(EMPTY_STATE);
  const [saved, setSaved] = useState(false);
  useEffect(() => setState(loadOnboardingWith(seed)), [seed]);
  const patch = (p: Partial<OnboardingState>) => {
    setSaved(false);
    setState((s) => ({ ...s, ...p }));
  };
  const save = () => {
    saveOnboarding(state);
    setSaved(true);
  };
  const line = state.headline.trim() || roleLine;
  const employerShown = employer && state.showEmployer ? employer : state.employment === 'company' && state.showEmployer && state.company.trim() ? state.company.trim() : null;
  return (
    <div className="ws-editor">
      <div className="ws-editor__form">
        <div className="ob__switches">
          <Switch isSelected={state.publish} onChange={(v) => patch({ publish: v })}>
            <strong>{t('onboarding3.profile.publish')}</strong>
            <span className="ob__switch-hint">{typo(t('onboarding3.profile.publishHint'))}</span>
          </Switch>
          <Switch isSelected={state.portraitConsent} onChange={(v) => patch({ portraitConsent: v })}>
            <strong>{t('me.public.portraitConsent')}</strong>
            <span className="ob__switch-hint">{typo(t('me.public.portraitLicence'))}</span>
          </Switch>
          <Switch isSelected={state.showEmployer} onChange={(v) => patch({ showEmployer: v })}>
            <strong>{t('me.public.showEmployer')}</strong>
            <span className="ob__switch-hint">{typo(t('onboarding3.profile.employerHint'))}</span>
          </Switch>
        </div>
        <div className="ws-field">
          <TextField
            label={t('onboarding3.who.headline')}
            description={t('onboarding3.who.headlineHint')}
            value={state.headline}
            onChange={(v) => patch({ headline: v.slice(0, 120) })}
            placeholder={t('onboarding3.who.headlinePlaceholder')}
          />
        </div>
        <div className="ws-field">
          <TagSelect
            label={t('me.public.topics')}
            description={t('onboarding3.interests.topicsHint')}
            options={TOPICS.map((tp) => ({ id: tp, label: t(`taxonomy.topics.${tp}` as 'taxonomy.topics.materials') }))}
            selected={state.topics}
            onChange={(v) => patch({ topics: v as OnboardingState['topics'] })}
          />
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
        <div className="ws-actions">
          <Button variant="accent" onPress={save}>
            {t('common.save')}
          </Button>
          {saved ? (
            <span className="ws-saved" role="status">
              <Check size={14} strokeWidth={2.5} aria-hidden="true" />
              {t('common.saved')}
            </span>
          ) : null}
          {publicHref ? (
            <NextLink href={publicHref} className="ws-more">
              {t('me.publicPage')}
            </NextLink>
          ) : null}
        </div>
        <p className="ws-note">{t('me.public.demoNote')}</p>
      </div>
      <aside className="ws-editor__preview" aria-label={t('me.public.previewTitle')}>
        <span className="ob__preview-kicker">
          {state.publish ? <Eye size={14} strokeWidth={2} aria-hidden="true" /> : <EyeOff size={14} strokeWidth={2} aria-hidden="true" />}
          {state.publish ? t('onboarding3.profile.previewPublic') : t('onboarding3.profile.previewHidden')}
        </span>
        <div className={`ob__card-person${state.publish ? '' : ' is-hidden'}`}>
          <PersonAvatar name={name} portrait={null} size={64} />
          <div className="ob__card-person-body">
            <strong>{name}</strong>
            <span>{typo(line)}</span>
            {employerShown ? <span className="ob__card-person-emp">{typo(employerShown)}</span> : null}
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
        <p className="ws-note">{state.portraitConsent ? t('me.public.portraitPending') : t('me.public.portraitHidden')}</p>
      </aside>
    </div>
  );
}
