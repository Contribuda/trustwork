'use client';

import { useEffect, useState } from 'react';
import NextLink from 'next/link';
import { ArrowUpRight, Pencil } from 'lucide-react';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import { EMPTY_STATE, completeness, loadOnboardingWith, type OnboardingState } from '@/components/onboarding/onboarding-state';
import { t } from '@/app/_lib/i18n';
import { regionLabel } from '@/app/_lib/country';
import { typo } from '@/app/_lib/typo';

/**
 * Identity card on «Моя страница»: name, role line (the onboarding headline when the person wrote one), employer,
 * self-declared statuses and the profile completeness ring. Server values are the baseline; the browser-session
 * onboarding answers layer on top until a backend stores them.
 */
export function MeProfileCard({
  name,
  roleLine,
  employer,
  publicHref,
  settingsHref,
  onboardingHref,
  baseline,
  seed,
}: {
  name: string;
  roleLine: string;
  employer: { name: string; href: string } | null;
  publicHref: string | null;
  settingsHref: string;
  onboardingHref: string;
  /** Share of the profile the server already knows (role line, topics, employer, public page). */
  baseline: number;
  seed: Partial<OnboardingState>;
}) {
  const [state, setState] = useState<OnboardingState | null>(null);
  useEffect(() => setState(loadOnboardingWith(seed)), [seed]);
  const s = state ?? EMPTY_STATE;
  const pct = Math.max(baseline, state ? completeness(s) : 0);
  const line = s.headline.trim() || (s.field ? t(`people.fieldOne.${s.field}` as 'people.fieldOne.management') : roleLine);
  const employment =
    s.employment === 'independent' ? t('onboarding3.employment.independent') : s.employment === 'seeking' ? t('onboarding3.employment.seeking') : s.employment === 'student' ? t('onboarding3.employment.student') : null;
  return (
    <section className="ws-identity" aria-label={t('me.title')}>
      <PersonAvatar name={name} portrait={null} size={64} />
      <div className="ws-identity__body">
        <span className="ws-identity__name">{name}</span>
        <span className="ws-identity__role">{typo(line)}</span>
        <span className="ws-identity__meta">
          {employer ? (
            <span>
              <NextLink href={employer.href}>{employer.name}</NextLink> · {t('me.membership.active')}
            </span>
          ) : (
            <span>{employment ?? t('me.membership.none')}</span>
          )}
          {s.regions.length ? <span>{s.regions.map((r) => regionLabel(r)).join(', ')}</span> : null}
          {publicHref ? (
            <NextLink href={publicHref}>
              {t('me.publicPage')} <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
            </NextLink>
          ) : (
            <span>{t('me.public.unpublished')}</span>
          )}
        </span>
        {s.signals.length ? (
          <span className="ws-identity__signals">
            {s.signals.map((sig) => (
              <span key={sig} className="ws-chip ws-chip--accent">
                {t(`signals.person.${sig}` as 'signals.person.openToWork')}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      <div className="ws-identity__side">
        <span className="ws-ring-row">
          <span className="ws-ring" style={{ ['--p' as string]: `${pct}%` }} aria-hidden="true">
            <span>{pct}%</span>
          </span>
          <span>
            <strong>{t('onboarding3.completenessTitle')}</strong>
            <span>{pct >= 60 ? t('me.profileGood') : t('me.profileMore')}</span>
          </span>
        </span>
        <span className="ws-actions">
          <NextLink href={onboardingHref} className="ws-more">
            <Pencil size={14} strokeWidth={2} aria-hidden="true" />
            {t('me.editProfile')}
          </NextLink>
          <NextLink href={settingsHref} className="ws-more">
            {t('me.accountSettings')}
          </NextLink>
        </span>
      </div>
    </section>
  );
}
