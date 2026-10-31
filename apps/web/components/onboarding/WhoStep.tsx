'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Briefcase, ClipboardCheck, Compass, Factory, HardHat, Layers, Package, ShoppingCart, Truck, Users, type LucideIcon } from 'lucide-react';
import { TextField } from '@trustwork/ui';
import type { PersonField } from '@/app/_lib/data/types';
import { t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import { StepFrame } from './StepFrame';
import { EMPTY_STATE, FIELDS, completeness, loadOnboarding, saveOnboarding, type Employment, type OnboardingState } from './onboarding-state';

const FIELD_ICONS: Record<PersonField, LucideIcon> = {
  management: Briefcase,
  engineering: Layers,
  design: Compass,
  procurement: ShoppingCart,
  sales: Package,
  production: Factory,
  construction: HardHat,
  logistics: Truck,
  control: ClipboardCheck,
  client: Users,
};
const EMPLOYMENT: Employment[] = ['company', 'independent', 'seeking', 'student'];

/** Step 1 «Кто вы в отрасли»: field of work, employment situation (free-text company name, no legal identifiers), one-line headline. */
export function WhoStep({ created, nextHref, skipHref, name }: { created: boolean; nextHref: string; skipHref: string; name: string }) {
  const router = useRouter();
  const [state, setState] = useState<OnboardingState>(EMPTY_STATE);
  useEffect(() => setState(loadOnboarding()), []);
  const patch = (p: Partial<OnboardingState>) => setState((s) => ({ ...s, ...p }));
  const save = () => {
    saveOnboarding(state);
    router.push(nextHref);
  };
  return (
    <StepFrame
      title={t('onboarding3.who.title', { name })}
      lede={t('onboarding3.who.lede')}
      created={created}
      completeness={completeness(state)}
      backHref={null}
      skipHref={skipHref}
      skipLabel={t('onboardingFlow.skip')}
      continueLabel={t('onboardingFlow.continue')}
      onContinue={save}
    >
      <fieldset className="ob__fieldset">
        <legend className="ob__legend">{t('onboarding3.who.field')}</legend>
        <p className="ob__hint">{t('onboarding3.who.fieldHint')}</p>
        <div className="ob__grid ob__grid--5" role="radiogroup" aria-label={t('onboarding3.who.field')}>
          {FIELDS.map((f) => {
            const Icon = FIELD_ICONS[f];
            const on = state.field === f;
            return (
              <button key={f} type="button" role="radio" aria-checked={on} className={`ob__tile${on ? ' is-on' : ''}`} onClick={() => patch({ field: on ? null : f })}>
                <Icon size={22} strokeWidth={1.75} aria-hidden="true" />
                <span>{t(`people.fields.${f}` as 'people.fields.management')}</span>
              </button>
            );
          })}
        </div>
      </fieldset>
      <fieldset className="ob__fieldset">
        <legend className="ob__legend">{t('onboarding3.who.employment')}</legend>
        <div className="ob__grid ob__grid--4" role="radiogroup" aria-label={t('onboarding3.who.employment')}>
          {EMPLOYMENT.map((e) => {
            const on = state.employment === e;
            return (
              <button key={e} type="button" role="radio" aria-checked={on} className={`ob__choice${on ? ' is-on' : ''}`} onClick={() => patch({ employment: on ? null : e })}>
                <strong>{t(`onboarding3.employment.${e}` as 'onboarding3.employment.company')}</strong>
                <span>{typo(t(`onboarding3.employmentHint.${e}` as 'onboarding3.employmentHint.company'))}</span>
              </button>
            );
          })}
        </div>
        {state.employment === 'company' ? (
          <div className="ob__field">
            <TextField
              label={t('onboarding3.who.company')}
              description={t('onboarding3.who.companyHint')}
              value={state.company}
              onChange={(v) => patch({ company: v.slice(0, 120) })}
              placeholder={t('onboarding3.who.companyPlaceholder')}
              autoComplete="organization"
            />
          </div>
        ) : null}
      </fieldset>
      <div className="ob__field">
        <TextField
          label={t('onboarding3.who.headline')}
          description={t('onboarding3.who.headlineHint')}
          value={state.headline}
          onChange={(v) => patch({ headline: v.slice(0, 120) })}
          placeholder={t('onboarding3.who.headlinePlaceholder')}
        />
      </div>
    </StepFrame>
  );
}
