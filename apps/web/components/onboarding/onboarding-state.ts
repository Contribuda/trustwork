import { regionCodes } from '@/app/_lib/country';
import type { PersonField, PersonSignalKind, TopicKey } from '@/app/_lib/data/types';

export type Employment = 'company' | 'independent' | 'seeking' | 'student';
export type Goal = 'learn' | 'work' | 'hire' | 'publish' | 'projects' | 'buy' | 'sell';
export const GOALS: Goal[] = ['learn', 'work', 'hire', 'publish', 'projects', 'buy', 'sell'];
export const FIELDS: PersonField[] = ['management', 'engineering', 'design', 'procurement', 'sales', 'production', 'construction', 'logistics', 'control', 'client'];
export const TOPICS: TopicKey[] = ['materials', 'technologies', 'markets', 'regulation', 'projects', 'people', 'events'];
export const CATEGORIES = ['materials', 'equipment', 'engineering', 'rawMaterials', 'works', 'designServices'] as const;
export const REGIONS: readonly string[] = regionCodes();
export const SIGNALS: PersonSignalKind[] = ['openToWork', 'openToProjects', 'hiring', 'lookingForPartners', 'consulting'];

/** Everything the five optional steps collect. Preferences only: no company authority, no legal identifiers. */
export type OnboardingState = {
  field: PersonField | null;
  employment: Employment | null;
  company: string;
  headline: string;
  goals: Goal[];
  topics: TopicKey[];
  categories: string[];
  regions: string[];
  publish: boolean;
  portraitConsent: boolean;
  showEmployer: boolean;
  signals: PersonSignalKind[];
};

export const EMPTY_STATE: OnboardingState = {
  field: null,
  employment: null,
  company: '',
  headline: '',
  goals: [],
  topics: [],
  categories: [],
  regions: [],
  publish: false,
  portraitConsent: false,
  showEmployer: true,
  signals: [],
};

const KEY = 'trustwork.onboarding';

/** Demo persistence: the browser session only (the real backend stores preferences on the person). */
export function loadOnboarding(): OnboardingState {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return { ...EMPTY_STATE };
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    return { ...EMPTY_STATE, ...parsed };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function saveOnboarding(state: OnboardingState): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable */
  }
}

/** Profile completeness in percent: eight optional groups, each worth the same; honest and local. */
export function completeness(s: OnboardingState): number {
  const groups = [s.field !== null, s.employment !== null, s.headline.trim().length > 0, s.goals.length > 0, s.topics.length > 0, s.categories.length > 0 || s.regions.length > 0, s.signals.length > 0, s.publish];
  return Math.round((groups.filter(Boolean).length / groups.length) * 100);
}

export function needsCategories(goals: Goal[]): boolean {
  return goals.includes('buy') || goals.includes('sell');
}

/**
 * The stored answers when the person went through onboarding in this browser session; otherwise the server-side
 * seed (what the account already knows) so that the workspace never shows a blank profile for a published person.
 */
export function loadOnboardingWith(seed: Partial<OnboardingState>): OnboardingState {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw) return { ...EMPTY_STATE, ...seed, ...(JSON.parse(raw) as Partial<OnboardingState>) };
  } catch {
    /* fall through to the seed */
  }
  return { ...EMPTY_STATE, ...seed };
}
