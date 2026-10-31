'use client';

import { useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Boxes, Compass, Cog, Hammer, Layers, Package, type LucideIcon } from 'lucide-react';
import { TagSelect, TextField } from '@trustwork/ui';
import type { TopicKey } from '@/app/_lib/data/types';
import { t } from '@/app/_lib/i18n';
import { regionLabel } from '@/app/_lib/country';
import { typo } from '@/app/_lib/typo';
import { StepFrame } from './StepFrame';
import { CATEGORIES, EMPTY_STATE, REGIONS, TOPICS, completeness, loadOnboarding, needsCategories, saveOnboarding, type OnboardingState } from './onboarding-state';

const CATEGORY_ICONS: Record<(typeof CATEGORIES)[number], LucideIcon> = { materials: Boxes, equipment: Cog, engineering: Layers, rawMaterials: Package, works: Hammer, designServices: Compass };

/**
 * Step 3 «Темы, направления и регионы»: reading topics for everyone; procurement categories only when the goals
 * include buying or selling (with client-side search); regions optional. Nothing here is required.
 */
export function InterestsStep({ nextHref, backHref, skipHref }: { nextHref: string; backHref: string; skipHref: string }) {
  const router = useRouter();
  const [state, setState] = useState<OnboardingState>(EMPTY_STATE);
  const [query, setQuery] = useState('');
  const countId = useId();
  useEffect(() => setState(loadOnboarding()), []);
  const patch = (p: Partial<OnboardingState>) => setState((s) => ({ ...s, ...p }));
  const save = () => {
    saveOnboarding(state);
    router.push(nextHref);
  };
  const visible = CATEGORIES.filter(
    (key) =>
      !query ||
      t(`taxonomy.${key}` as 'taxonomy.materials')
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <StepFrame
      title={t('onboarding3.interests.title')}
      lede={t('onboarding3.interests.lede')}
      completeness={completeness(state)}
      backHref={backHref}
      skipHref={skipHref}
      skipLabel={t('onboarding2.setupLater')}
      continueLabel={t('onboardingFlow.continue')}
      onContinue={save}
    >
      <fieldset className="ob__fieldset">
        <legend className="ob__legend">{t('onboarding3.interests.topics')}</legend>
        <p className="ob__hint">{typo(t('onboarding3.interests.topicsHint'))}</p>
        <div className="ob__chips">
          {TOPICS.map((tp) => {
            const on = state.topics.includes(tp);
            return (
              <label key={tp} className={`ob__chip${on ? ' is-on' : ''}`}>
                <input type="checkbox" className="ob__card-input" checked={on} onChange={() => patch({ topics: on ? state.topics.filter((x) => x !== tp) : [...state.topics, tp as TopicKey] })} />
                {on ? <Check size={14} strokeWidth={2.5} aria-hidden="true" /> : null}
                {t(`taxonomy.topics.${tp}` as 'taxonomy.topics.materials')}
              </label>
            );
          })}
        </div>
      </fieldset>
      {needsCategories(state.goals) ? (
        <fieldset className="ob__fieldset">
          <legend className="ob__legend">{t('onboarding2.directions')}</legend>
          <p className="ob__hint">{t('onboarding2.multiDirectionsHint')}</p>
          <div className="ob__field ob__field--search">
            <TextField label={t('onboarding2.directionsSearch')} value={query} onChange={setQuery} inputMode="search" aria-describedby={countId} />
          </div>
          <p id={countId} className="ob__hint" aria-live="polite">
            {visible.length ? t('onboarding2.directionsCount', { count: visible.length }) : t('onboarding2.noMatches')}
          </p>
          <div className="ob__grid ob__grid--3">
            {visible.map((key) => {
              const Icon = CATEGORY_ICONS[key];
              const on = state.categories.includes(key);
              return (
                <label key={key} className={`ob__choice ob__choice--row${on ? ' is-on' : ''}`}>
                  <input type="checkbox" className="ob__card-input" checked={on} onChange={() => patch({ categories: on ? state.categories.filter((x) => x !== key) : [...state.categories, key] })} />
                  <span className="ob__choice-icon" aria-hidden="true">
                    <Icon size={20} strokeWidth={1.75} />
                  </span>
                  <strong>{t(`taxonomy.${key}` as 'taxonomy.materials')}</strong>
                  <span className="ob__card-check" aria-hidden="true" />
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}
      <div className="ob__field">
        <TagSelect
          label={`${t('onboarding3.interests.regions')} (${t('onboarding2.optional')})`}
          description={t('onboarding3.interests.regionsHint')}
          options={REGIONS.map((key) => ({ id: key, label: regionLabel(key) }))}
          selected={state.regions}
          onChange={(v) => patch({ regions: v })}
        />
      </div>
    </StepFrame>
  );
}
