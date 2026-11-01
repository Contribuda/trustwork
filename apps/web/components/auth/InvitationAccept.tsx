'use client';

import { useEffect, useState } from 'react';
import { InvitationLinkCommandSchema, InvitationPreviewSchema, type InvitationPreview } from '@trustwork/contracts/client';
import { Building2, CheckCircle2 } from 'lucide-react';
import { Button, ButtonLink, EmptyState, FormActions, FormAlert } from '@trustwork/ui';
import { postJson, validateCommand } from '@/app/_lib/api-client';
import { t } from '@/app/_lib/i18n';
import { alertFor, useAuthForm } from './useAuthForm';

type View = { kind: 'loading' } | { kind: 'ready'; preview: InvitationPreview } | { kind: 'invalid' } | { kind: 'accepted'; company: string } | { kind: 'demo' } | { kind: 'failed'; text: string };

/** Codes that mean "this link cannot be used by this account": the same card, existence is never disclosed. */
const INVALID = new Set(['access.not_found', 'membership.invitation_expired', 'validation.schema', 'validation.unknown_field']);

/** Signed out: sign in with the invited account and come back to this page (QA-002 D1). */
export function InvitationSignIn({ next }: { next: string }) {
  return (
    <div className="au-form">
      <h1 tabIndex={-1} className="au-form__title">
        {t('auth.invitation.title')}
      </h1>
      <p className="au-form__sub">{t('auth.invitation.signInBody')}</p>
      <FormActions align="stretch">
        <ButtonLink href={`/login?next=${encodeURIComponent(next)}`} fullWidth>
          {t('auth.invitation.signIn')}
        </ButtonLink>
      </FormActions>
      <p className="au-form__note">{t('auth.invitation.noAccount')}</p>
    </div>
  );
}

/**
 * The signed-in invitee's view of the invitation link: the company and role (checked without spending the token), then
 * one button that accepts it. Someone else's, used, expired or unknown links show the same card; a person who already
 * works for another company sees why accepting is refused. A demo deployment sends nothing.
 */
export function InvitationAccept({ membershipId, token, demoMode }: { membershipId: string; token: string; demoMode: boolean }) {
  const [view, setView] = useState<View>({ kind: 'loading' });
  const form = useAuthForm();
  const payload = { membershipId, invitationToken: token };

  useEffect(() => {
    let live = true;
    void (async () => {
      if (!validateCommand(InvitationLinkCommandSchema, payload).ok) return setView({ kind: 'invalid' });
      if (demoMode) return setView({ kind: 'demo' });
      const response = await postJson('/v1/invitations/preview', payload);
      if (!live) return;
      if (response.kind === 'ok') {
        const parsed = InvitationPreviewSchema.safeParse(response.body);
        setView(parsed.success ? { kind: 'ready', preview: parsed.data } : { kind: 'failed', text: t('error.network') });
      } else if (response.kind === 'error' && INVALID.has(response.error.code)) setView({ kind: 'invalid' });
      else setView({ kind: 'failed', text: response.kind === 'error' ? alertFor(response.error).text : t('error.network') });
    })();
    return () => {
      live = false;
    };
    // The link does not change while the page is open: the preview runs once.
  }, []);

  const title = (
    <h1 tabIndex={-1} className="au-form__title">
      {t('auth.invitation.title')}
    </h1>
  );

  if (view.kind === 'invalid') {
    return (
      <div className="au-form">
        {title}
        <EmptyState tone="error" title={t('auth.invitation.invalid')} headingLevel={2} actions={<ButtonLink href="/app">{t('auth.invitation.toWorkspace')}</ButtonLink>}>
          <p>{t('auth.invitation.invalidBody')}</p>
        </EmptyState>
      </div>
    );
  }

  if (view.kind === 'accepted') {
    return (
      <div className="au-form">
        <div className="au-verify">
          <span className="au-verify__icon" aria-hidden="true">
            <CheckCircle2 size={26} strokeWidth={1.75} />
          </span>
          {title}
          <FormAlert tone="success" autoFocus>
            {t('auth.invitation.accepted', { company: view.company })}
          </FormAlert>
          <FormActions align="stretch">
            <ButtonLink href="/app/company" fullWidth>
              {t('auth.invitation.openCompany')}
            </ButtonLink>
          </FormActions>
        </div>
      </div>
    );
  }

  return (
    <div className="au-form">
      <div className="au-verify">
        <span className="au-verify__icon" aria-hidden="true">
          <Building2 size={26} strokeWidth={1.75} />
        </span>
        {title}
        {view.kind === 'loading' ? (
          <p className="au-form__sub" role="status">
            {t('auth.invitation.loading')}
          </p>
        ) : null}
        {view.kind === 'demo' ? <FormAlert tone="info">{t('auth.invitation.demo')}</FormAlert> : null}
        {view.kind === 'failed' ? <FormAlert tone="error">{view.text}</FormAlert> : null}
        {view.kind === 'ready' ? (
          <>
            <p className="au-form__sub">{t('auth.invitation.lead', { company: view.preview.company.name, role: t(`auth.invitation.role.${view.preview.role}`) })}</p>
            <p className="au-form__note">{t('auth.invitation.oneEmployer')}</p>
            {form.alert ? (
              <FormAlert tone={form.alert.tone} autoFocus>
                {form.alert.text}
              </FormAlert>
            ) : null}
            <FormActions align="stretch">
              <Button
                fullWidth
                isLoading={form.busy}
                pendingLabel={t('auth.invitation.accepting')}
                onPress={async () => {
                  const response = await form.submit({ path: '/v1/invitations/accept', payload, schema: InvitationLinkCommandSchema, idempotent: true });
                  if (response.kind === 'ok') setView({ kind: 'accepted', company: view.preview.company.name });
                  else if (response.kind === 'error' && INVALID.has(response.error.code)) setView({ kind: 'invalid' });
                }}
              >
                {t('auth.invitation.accept')}
              </Button>
            </FormActions>
          </>
        ) : null}
      </div>
    </div>
  );
}
