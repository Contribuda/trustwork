import type { Metadata } from 'next';
import { AuthFrame } from '@/components/auth/AuthFrame';
import { InvitationAccept, InvitationSignIn } from '@/components/auth/InvitationAccept';
import { getPrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { t } from '@/app/_lib/i18n';
import { artwork } from '@/app/_lib/media';
import { primeLocale } from '@/app/_lib/locale';
import { demoModeEnabled } from '@/app/_lib/persona';

type Params = { params: Promise<{ membershipId: string; token: string }>; searchParams: PageSearchParams };

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  // The address carries a one-time token: it is never sent on as a referrer and never indexed.
  return { title: t('auth.invitation.title'), referrer: 'no-referrer', robots: { index: false, follow: false } };
}

/**
 * Landing page of the invitation link (`/invitations/<membershipId>/<token>`, the mail link template of MAIL-001,
 * QA-002 D1). Opening the link changes nothing. A signed-in person sees the inviting company and the offered role,
 * checked without spending the token (`POST /v1/invitations/preview`), and accepts with a button
 * (`POST /v1/invitations/accept`, single use, no company id needed). A visitor without a session signs in first and
 * comes back here; invitations go only to existing accounts, so there is nothing to sign up for.
 */
export default async function InvitationPage({ params, searchParams }: Params) {
  await primeLocale();
  const { membershipId, token } = await params;
  const principal = await getPrincipal(searchParams);
  const here = `/invitations/${encodeURIComponent(membershipId)}/${encodeURIComponent(token)}`;
  return (
    <AuthFrame
      headline={t('auth.visual.loginHeadline')}
      subline={t('auth.visual.loginSub')}
      media={artwork('glass-grid')}
      points={[
        { icon: 'companies', text: t('auth.points.companies') },
        { icon: 'projects', text: t('auth.points.projects') },
        { icon: 'trust', text: t('auth.points.trust') },
      ]}
    >
      {principal.kind === 'person' ? <InvitationAccept membershipId={membershipId} token={token} demoMode={demoModeEnabled()} /> : <InvitationSignIn next={here} />}
    </AuthFrame>
  );
}
