'use client';

import type { ReactNode } from 'react';
import NextLink from '@/components/locale/LocalLink';
import { ArrowLeft, ArrowRight, CheckCircle2 } from 'lucide-react';
import { t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';

/**
 * One onboarding step: optional «Аккаунт создан» pill, title, lede, the completeness meter, the content and the
 * action bar (back, skip, continue). The bar sticks to the bottom on phones.
 */
export function StepFrame({
  title,
  lede,
  created = false,
  completeness,
  backHref,
  skipHref,
  skipLabel,
  continueLabel,
  onContinue,
  children,
  aside,
}: {
  title: string;
  lede: string;
  created?: boolean;
  completeness: number;
  backHref: string | null;
  skipHref: string;
  skipLabel: string;
  continueLabel: string;
  onContinue: () => void;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <>
      {created ? (
        <p className="ob__pill">
          <CheckCircle2 size={16} strokeWidth={2} aria-hidden="true" />
          {t('onboarding2.accountCreated')}
        </p>
      ) : null}
      <div className="ob__head">
        <div>
          <h1 tabIndex={-1} className="ob__title">
            {typo(title)}
          </h1>
          <p className="ob__lede">{typo(lede)}</p>
        </div>
        <div className="ob__meter" aria-label={t('onboarding3.completeness', { percent: completeness })}>
          <span className="ob__meter-ring" style={{ ['--p' as string]: `${completeness}%` }} aria-hidden="true">
            <span>{completeness}%</span>
          </span>
          <span className="ob__meter-text">
            <strong>{t('onboarding3.completenessTitle')}</strong>
            <span>{t('onboarding3.completenessHint')}</span>
          </span>
        </div>
      </div>
      <div className={`ob__body${aside ? ' ob__body--aside' : ''}`}>
        <div className="ob__content">{children}</div>
        {aside ? <div className="ob__aside">{aside}</div> : null}
      </div>
      <p className="ob__note">{t('onboardingFlow.noAuthorityNote')}</p>
      <p className="ob__note">{t('onboarding2.demoNote')}</p>
      <div className="ob__actions">
        {backHref ? (
          <NextLink href={backHref} className="ob__back">
            <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
            {t('onboardingFlow.back')}
          </NextLink>
        ) : (
          <span />
        )}
        <span className="ob__actions-right">
          <NextLink href={skipHref} className="ob__skip">
            {skipLabel}
          </NextLink>
          <button type="button" className="pub-btn pub-btn--dark" onClick={onContinue}>
            {continueLabel}
            <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </span>
      </div>
    </>
  );
}
