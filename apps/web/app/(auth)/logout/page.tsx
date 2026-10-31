import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthFrame } from '@/components/auth/AuthFrame';
import { LogoutForm } from '@/components/auth/LogoutForm';
import { getPrincipal } from '@/app/_lib/principal';
import { t } from '@/app/_lib/i18n';
import { artwork } from '@/app/_lib/media';
import { primeLocale } from '@/app/_lib/locale';
import { demoModeEnabled } from '@/app/_lib/persona';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('auth.logout.title') };
}

/**
 * Sign-out (WEB-004). The avatar menu links here; signing out is a POST (`/v1/auth/logout`) behind a button, never a
 * side effect of opening a link, so a foreign page cannot sign the visitor out. Visitors without a session go home;
 * the demo signs out by switching to the guest persona.
 */
export default async function LogoutPage() {
  await primeLocale();
  if (demoModeEnabled()) redirect('/?persona=anonymous');
  const principal = await getPrincipal(undefined);
  if (principal.kind !== 'person') redirect('/');
  return (
    <AuthFrame
      headline={t('auth.visual.loginHeadline')}
      subline={t('auth.visual.loginSub')}
      media={artwork('glass-grid')}
      points={[
        { icon: 'companies', text: t('auth.points.companies') },
        { icon: 'projects', text: t('auth.points.projects') },
        { icon: 'magazine', text: t('auth.points.magazine') },
      ]}
    >
      <LogoutForm name={principal.displayName} />
    </AuthFrame>
  );
}
