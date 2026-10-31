import type { Metadata } from 'next';
import { AuthFrame } from '@/components/auth/AuthFrame';
import { RecoverForm } from '@/components/auth/RecoverForm';
import type { PageSearchParams } from '@/app/_lib/principal';
import { t } from '@/app/_lib/i18n';
import { artwork } from '@/app/_lib/media';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('auth.recover.title') };
}

/** Built per request: the labels follow the active locale. */
function points() {
  return [
    { icon: 'trust' as const, text: t('auth.points.recoverSafe') },
    { icon: 'companies' as const, text: t('auth.points.companies') },
    { icon: 'magazine' as const, text: t('auth.points.magazine') },
  ];
}

export default async function RecoverPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const params = await searchParams;
  const email = typeof params.email === 'string' && params.email.length <= 254 ? params.email : '';
  return (
    <AuthFrame headline={t('auth.visual.recoverHeadline')} subline={t('auth.visual.recoverSub')} media={artwork('blueprint-lines')} points={points()}>
      <RecoverForm initialEmail={email} />
    </AuthFrame>
  );
}
