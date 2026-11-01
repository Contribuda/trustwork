'use client';

import type { ReactNode } from 'react';
import NextLink from '@/components/locale/LocalLink';
import { ArrowUpRight } from 'lucide-react';
import { Avatar, Brand } from '@trustwork/ui';
import { t } from '@/app/_lib/i18n';

export type OnboardingStepId = 'who' | 'goals' | 'interests' | 'profile';
export const STEP_ORDER: OnboardingStepId[] = ['who', 'goals', 'interests', 'profile'];

/**
 * Onboarding shell: brand, «На сайт», the person's initial; a numbered stepper (every step optional), the centred
 * column and the footer with «Помощь» last. The completeness meter is rendered by the steps (it needs the state).
 */
export function OnboardingShell({ name, step, children }: { name: string; step: OnboardingStepId | 'done'; children: ReactNode }) {
  const index = step === 'done' ? STEP_ORDER.length : STEP_ORDER.indexOf(step);
  return (
    <div className="ob">
      <a href="#main" className="skip-link">
        {t('publicShell.skipToContent')}
      </a>
      <header className="ob__top">
        <Brand href="/" height={36} />
        <div className="ob__top-right">
          <NextLink href="/" className="ob__site">
            {t('onboarding2.toSite')}
            <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
          </NextLink>
          <Avatar name={name} size={36} />
        </div>
      </header>
      <ol className="ob__steps" aria-label={t('onboarding2.stepsLabel')}>
        {STEP_ORDER.map((id, i) => (
          <li key={id} className={`ob__step${i < index ? ' is-done' : ''}${i === index ? ' is-current' : ''}`} aria-current={i === index ? 'step' : undefined}>
            <span className="ob__step-num" aria-hidden="true">
              {i + 1}
            </span>
            <span className="ob__step-label">{t(`onboarding3.steps.${id}` as 'onboarding3.steps.who')}</span>
          </li>
        ))}
      </ol>
      <main id="main" tabIndex={-1} className="ob__main">
        {children}
      </main>
      <footer className="ob__footer">
        <NextLink href="/legal/privacy">{t('footer.privacy')}</NextLink>
        <NextLink href="/legal/terms">{t('footer.terms')}</NextLink>
        <NextLink href="/#help">{t('footer.help')}</NextLink>
      </footer>
    </div>
  );
}
