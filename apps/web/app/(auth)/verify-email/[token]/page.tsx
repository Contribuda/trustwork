import type { Metadata } from 'next';
import { AuthFrame } from '@/components/auth/AuthFrame';
import { VerifyEmailForm } from '@/components/auth/VerifyEmailForm';
import { t } from '@/app/_lib/i18n';
import { artwork } from '@/app/_lib/media';
import { primeLocale } from '@/app/_lib/locale';
import { demoModeEnabled } from '@/app/_lib/persona';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('auth.verifyEmail.title'), referrer: 'no-referrer' };
}

/**
 * Landing page of the verification link (`/verify-email/<token>`, the mail link template of MAIL-001). Opening the
 * link changes nothing: mail scanners prefetch links, and GET never mutates. The person confirms with a button,
 * which spends the single-use token (`POST /v1/auth/verify-email`) and starts the first session.
 */
export default async function VerifyEmailPage({ params }: { params: Promise<{ token: string }> }) {
  await primeLocale();
  const { token } = await params;
  return (
    <AuthFrame
      headline={t('auth.visual.signupHeadline')}
      subline={t('auth.visual.signupSub')}
      media={artwork('blueprint-lines')}
      points={[
        { icon: 'people', text: t('auth.points.profile') },
        { icon: 'academy', text: t('auth.points.academy') },
        { icon: 'trust', text: t('auth.points.trust') },
      ]}
    >
      <VerifyEmailForm token={token} demoMode={demoModeEnabled()} />
    </AuthFrame>
  );
}
