'use client';

import { useEffect, useState } from 'react';
import NextLink from 'next/link';
import { ArrowRight, BookOpenCheck, Building2, GraduationCap, PenLine, Settings2, Users } from 'lucide-react';
import type { Course } from '@/app/_lib/data/types';
import { t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import { EMPTY_STATE, completeness, loadOnboarding, type Goal, type OnboardingState } from './onboarding-state';

type Rec = { icon: 'magazine' | 'people' | 'companies' | 'publish' | 'academy'; title: string; body: string; href: string; cta: string };
const ICONS = { magazine: BookOpenCheck, people: Users, companies: Building2, publish: PenLine, academy: GraduationCap } as const;

function recommendations(goals: Goal[], workspaceHref: string): Rec[] {
  const out: Rec[] = [];
  const has = (g: Goal) => goals.includes(g);
  if (has('learn') || goals.length === 0) out.push({ icon: 'magazine', title: t('onboarding3.done.recMagazine'), body: t('onboarding3.done.recMagazineBody'), href: '/magazine', cta: t('onboarding3.done.open') });
  if (has('work') || has('hire')) out.push({ icon: 'people', title: t('onboarding3.done.recPeople'), body: t('onboarding3.done.recPeopleBody'), href: '/people', cta: t('onboarding3.done.open') });
  if (has('buy') || has('sell') || has('projects'))
    out.push({ icon: 'companies', title: t('onboarding3.done.recCompanies'), body: t('onboarding3.done.recCompaniesBody'), href: has('projects') ? '/projects' : '/companies', cta: t('onboarding3.done.open') });
  if (has('publish'))
    out.push({
      icon: 'publish',
      title: t('onboarding3.done.recPublish'),
      body: t('onboarding3.done.recPublishBody'),
      href: `${workspaceHref.split('?')[0]}/publications${workspaceHref.includes('?') ? `?${workspaceHref.split('?')[1]}` : ''}`,
      cta: t('onboarding3.done.open'),
    });
  return out.slice(0, 3);
}

/** Step 5 «Готово»: completeness, what the person chose, recommendations by goals, courses by topics, the workspace link. */
export function DoneStep({ name, workspaceHref, settingsHref, courses }: { name: string; workspaceHref: string; settingsHref: string; courses: Course[] }) {
  const [state, setState] = useState<OnboardingState>(EMPTY_STATE);
  useEffect(() => setState(loadOnboarding()), []);
  const pct = completeness(state);
  const picked = courses.filter((c) => !state.topics.length || c.topics.some((tp) => state.topics.includes(tp))).slice(0, 3);
  const recs = recommendations(state.goals, workspaceHref);
  return (
    <div className="ob__done">
      <div className="ob__done-head">
        <span className="ob__meter-ring ob__meter-ring--lg" style={{ ['--p' as string]: `${pct}%` }} aria-hidden="true">
          <span>{pct}%</span>
        </span>
        <div>
          <h1 tabIndex={-1} className="ob__title">
            {typo(t('onboarding3.done.title', { name }))}
          </h1>
          <p className="ob__lede">{typo(pct >= 60 ? t('onboarding3.done.ledeGood') : t('onboarding3.done.ledeMore'))}</p>
          <p className="ob__hint">{t('onboarding2.demoNote')}</p>
        </div>
      </div>
      <div className="ob__done-grid">
        <section className="ob__done-card" aria-labelledby="done-next">
          <h2 id="done-next" className="ob__h2">
            {t('onboarding3.done.next')}
          </h2>
          <ul className="ob__recs">
            {recs.map((r) => {
              const Icon = ICONS[r.icon];
              return (
                <li key={r.icon}>
                  <NextLink href={r.href} className="ob__rec">
                    <span className="ob__rec-icon" aria-hidden="true">
                      <Icon size={20} strokeWidth={1.75} />
                    </span>
                    <span>
                      <strong>{r.title}</strong>
                      <span>{typo(r.body)}</span>
                    </span>
                    <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
                  </NextLink>
                </li>
              );
            })}
          </ul>
        </section>
        <section className="ob__done-card" aria-labelledby="done-academy">
          <h2 id="done-academy" className="ob__h2">
            <GraduationCap size={18} strokeWidth={2} aria-hidden="true" />
            {t('onboarding3.done.academy')}
          </h2>
          <p className="ob__hint">{typo(t('onboarding3.done.academyBody'))}</p>
          <ul className="ob__courses">
            {picked.map((c) => (
              <li key={c.id}>
                <strong>{typo(c.title)}</strong>
                <span>
                  {t('magazine.academyModules', { count: c.modules })} · {t('magazine.academyMinutes', { count: c.durationMinutes })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <div className="ob__actions ob__actions--done">
        <NextLink href={settingsHref} className="ob__skip">
          <Settings2 size={16} strokeWidth={2} aria-hidden="true" />
          {t('onboarding3.done.settings')}
        </NextLink>
        <NextLink href={workspaceHref} className="pub-btn pub-btn--dark">
          {t('onboarding3.done.workspace')}
          <ArrowRight size={16} strokeWidth={2} aria-hidden="true" />
        </NextLink>
      </div>
    </div>
  );
}
