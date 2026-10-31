import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { AuthFrame } from '@/components/auth/AuthFrame';
import { LoginForm } from '@/components/auth/LoginForm';
import { getPrincipal, hrefFor, type PageSearchParams } from '@/app/_lib/principal';
import { t } from '@/app/_lib/i18n';
import { artwork } from '@/app/_lib/media';
import { safeNext } from '@/app/_lib/safe-next';
import { primeLocale } from '@/app/_lib/locale';
import { demoModeEnabled } from '@/app/_lib/persona';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('auth.login.title') };
}

export default async function LoginPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const params = await searchParams;
  const principal = await getPrincipal(params);
  const next = safeNext(params.next);
  if (principal.kind === 'person') redirect(hrefFor(principal, next ?? '/app'));
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
      <LoginForm next={next} reason={typeof params.reason === 'string' ? params.reason : null} demoMode={demoModeEnabled()} />
    </AuthFrame>
  );
}
