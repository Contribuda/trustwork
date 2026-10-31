'use client';

import { useCallback, useEffect, useState } from 'react';
import NextLink from '@/components/locale/LocalLink';
import { useRouter } from 'next/navigation';
import { Check, Eye, EyeOff, MapPin } from 'lucide-react';
import { Button, Switch, TagSelect, TextField } from '@trustwork/ui';
import { PersonAvatar } from '@/components/public/PersonAvatar';
import { EMPTY_STATE, SIGNALS, TOPICS, loadOnboardingWith, saveOnboarding, type OnboardingState } from '@/components/onboarding/onboarding-state';
import { newIdempotencyKey, postJson, type ApiResult } from '@/app/_lib/api-client';
import { withBase } from '@/app/_lib/base-path';
import { t } from '@/app/_lib/i18n';
import { regionLabel } from '@/app/_lib/country';
import { typo } from '@/app/_lib/typo';

/**
 * The parts of `GET /v1/me/profile` (PPL-001, contract `MyProfileViewSchema`) the editor needs. The server validates
 * the full view; the editor only reads it.
 */
type OwnerProfile = {
  person: { profileVisibility: 'private' | 'public'; headline: string | null; expertise: string[] };
  profile: { revision: number; roleLine: string | null; regionCode: string | null; languages: string[] } | null;
  consents: { id: string; purpose: string; withdrawnAt: string | null }[];
  publicPreview: unknown | null;
  notices: Record<string, string>;
};
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

async function loadOwnerProfile(): Promise<OwnerProfile | null> {
  try {
    const response = await fetch(withBase('/v1/me/profile'), { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } });
    return response.ok ? ((await response.json()) as OwnerProfile) : null;
  } catch {
    return null;
  }
}
const failed = (result: ApiResult) => result.kind !== 'ok';

/**
 * Public projection editor: what `/people/[handle]` shows. Publishing is a consent to the current notice and hiding
 * withdraws it; the portrait needs its own consent (and a licence record for the image); the employer line is
 * optional. In demo mode it saves to the browser session; on the live API (`live`) it saves the profile, the consents
 * and the visibility through `/v1/me/*` (PPL-001), and the preview shows exactly the public parts.
 */
export function MePublicEditor({ name, roleLine, employer, publicHref, seed, live = false }: { name: string; roleLine: string; employer: string | null; publicHref: string | null; seed: Partial<OnboardingState>; live?: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<OnboardingState>(EMPTY_STATE);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [owner, setOwner] = useState<OwnerProfile | null>(null);
  useEffect(() => setState(live ? { ...EMPTY_STATE, ...seed } : loadOnboardingWith(seed)), [seed, live]);
  const refresh = useCallback(async () => setOwner(await loadOwnerProfile()), []);
  useEffect(() => {
    if (live) void refresh();
  }, [live, refresh]);
  const patch = (p: Partial<OnboardingState>) => {
    setStatus('idle');
    setState((s) => ({ ...s, ...p }));
  };

  const saveLive = async (current: OwnerProfile) => {
    setStatus('saving');
    const publicFields = ['roleLine', 'region', 'topics', 'experience', ...(state.showEmployer ? ['employer'] : []), ...(state.portraitConsent ? ['portrait'] : [])];
    const steps: (() => Promise<ApiResult>)[] = [
      () => postJson('/v1/me/profile', {
        expectedRevision: current.profile?.revision ?? null, headline: state.headline.trim() || null, expertise: current.person.expertise, roleLine: current.profile?.roleLine ?? null,
        regionCode: current.profile?.regionCode ?? null, showEmployer: state.showEmployer, topics: state.topics, languages: current.profile?.languages ?? [], publicFields,
      }, { idempotencyKey: newIdempotencyKey() }),
    ];
    const portraitConsent = current.consents.find((c) => c.purpose === 'portrait_display' && c.withdrawnAt === null);
    if (state.portraitConsent && !portraitConsent) {
      steps.push(() => postJson('/v1/me/consents', { purpose: 'portrait_display', target: null, noticeVersion: current.notices.portrait_display ?? 'portrait_display.v1' }, { idempotencyKey: newIdempotencyKey() }));
    }
    if (!state.portraitConsent && portraitConsent) {
      steps.push(() => postJson(`/v1/me/consents/${portraitConsent.id}/withdraw`, { reason: 'Withdrawn on My page' }, { idempotencyKey: newIdempotencyKey() }));
    }
    const isPublic = current.person.profileVisibility === 'public' && current.publicPreview !== null;
    if (state.publish !== isPublic) {
      steps.push(() => postJson('/v1/me/profile/visibility', state.publish ? { visibility: 'public', noticeVersion: current.notices.profile_public ?? 'profile_public.v1' } : { visibility: 'private' }, { idempotencyKey: newIdempotencyKey() }));
    }
    for (const step of steps) {
      if (failed(await step())) {
        setStatus('error');
        await refresh();
        return;
      }
    }
    await refresh();
    setStatus('saved');
    router.refresh();
  };
  const save = () => {
    if (live) {
      if (owner) void saveLive(owner);
      else setStatus('error');
      return;
    }
    saveOnboarding(state);
    setStatus('saved');
  };
  const line = state.headline.trim() || roleLine;
  const employerShown = employer && state.showEmployer ? employer : state.employment === 'company' && state.showEmployer && state.company.trim() ? state.company.trim() : null;
  return (
    <div className="ws-editor">
      <div className="ws-editor__form">
        <div className="ob__switches">
          <Switch isSelected={state.publish} onChange={(v) => patch({ publish: v })}>
            <strong>{t('onboarding3.profile.publish')}</strong>
            <span className="ob__switch-hint">{typo(live ? t('me.public.notice.profilePublic') : t('onboarding3.profile.publishHint'))}</span>
          </Switch>
          <Switch isSelected={state.portraitConsent} onChange={(v) => patch({ portraitConsent: v })}>
            <strong>{t('me.public.portraitConsent')}</strong>
            <span className="ob__switch-hint">{typo(live ? t('me.public.notice.portraitDisplay') : t('me.public.portraitLicence'))}</span>
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
        {live ? null : (
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
        )}
        <div className="ws-actions">
          <Button variant="accent" onPress={save} isDisabled={status === 'saving'}>
            {status === 'saving' ? t('me.public.saving') : t('common.save')}
          </Button>
          <span role="status" aria-live="polite" className={status === 'saved' ? 'ws-saved' : undefined}>
            {status === 'saved' ? (
              <>
                <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                {t('common.saved')}
              </>
            ) : null}
          </span>
          {publicHref ? (
            <NextLink href={publicHref} className="ws-more">
              {t('me.publicPage')}
            </NextLink>
          ) : null}
        </div>
        {status === 'error' ? (
          <p className="ws-note" role="alert">
            {t('me.public.saveFailed')}
          </p>
        ) : null}
        <p className="ws-note">{live ? t('me.public.liveNote') : t('me.public.demoNote')}</p>
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
