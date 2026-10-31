'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpenCheck, Briefcase, FolderKanban, Handshake, PenLine, Package, ShoppingCart, type LucideIcon } from 'lucide-react';
import { t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import { StepFrame } from './StepFrame';
import { EMPTY_STATE, GOALS, completeness, loadOnboarding, saveOnboarding, type Goal, type OnboardingState } from './onboarding-state';

const ICONS: Record<Goal, LucideIcon> = { learn: BookOpenCheck, work: Briefcase, hire: Handshake, publish: PenLine, projects: FolderKanban, buy: ShoppingCart, sell: Package };

/** Step 2 «Что вы хотите делать»: multi-select goals (R22); zero selections is a valid answer and «Продолжить» stays enabled. */
export function GoalsStep({ nextHref, backHref, skipHref }: { nextHref: string; backHref: string; skipHref: string }) {
  const router = useRouter();
  const [state, setState] = useState<OnboardingState>(EMPTY_STATE);
  useEffect(() => setState(loadOnboarding()), []);
  const toggle = (g: Goal) => setState((s) => ({ ...s, goals: s.goals.includes(g) ? s.goals.filter((x) => x !== g) : [...s.goals, g] }));
  const save = () => {
    saveOnboarding(state);
    router.push(nextHref);
  };
  return (
    <StepFrame
      title={t('onboarding3.goals.title')}
      lede={t('onboarding3.goals.lede')}
      completeness={completeness(state)}
      backHref={backHref}
      skipHref={skipHref}
      skipLabel={t('onboardingFlow.skip')}
      continueLabel={t('onboardingFlow.continue')}
      onContinue={save}
    >
      <p className="ob__hint">{t('onboardingFlow.multiHint')}</p>
      <div className="ob__cards">
        {GOALS.map((g) => {
          const Icon = ICONS[g];
          const on = state.goals.includes(g);
          return (
            <label key={g} className={`ob__card${on ? ' is-on' : ''}`}>
              <input type="checkbox" className="ob__card-input" checked={on} onChange={() => toggle(g)} />
              <span className="ob__card-icon" aria-hidden="true">
                <Icon size={22} strokeWidth={1.75} />
              </span>
              <span className="ob__card-check" aria-hidden="true" />
              <span className="ob__card-title">{t(`onboarding3.goal.${g}.title` as 'onboarding3.goal.learn.title')}</span>
              <span className="ob__card-desc">{typo(t(`onboarding3.goal.${g}.desc` as 'onboarding3.goal.learn.desc'))}</span>
              <span className="ob__card-tags">{t(`onboarding3.goal.${g}.tags` as 'onboarding3.goal.learn.tags')}</span>
            </label>
          );
        })}
      </div>
      <p className="ob__hint" aria-live="polite">
        {state.goals.length ? t('onboardingFlow.selectedCount', { count: state.goals.length }) : t('onboarding3.goals.none')}
      </p>
    </StepFrame>
  );
}
