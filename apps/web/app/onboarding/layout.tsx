import type { ReactNode } from 'react';
import '../auth.css';
import { primeLocale } from '@/app/_lib/locale';

/** Onboarding routes share the auth stylesheet (au-* and ob-* classes); the shell itself is rendered by each step. */
export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  await primeLocale();
  return children;
}
