import type { Metadata } from 'next';
import NextLink from '@/components/locale/LocalLink';
import { ArrowRight, KeyRound, Laptop, Mail, ShieldCheck, Smartphone } from 'lucide-react';
import { Button, StatusChip } from '@/components/ui';
import { SettingsPreferences } from '@/components/workspace/SettingsPreferences';
import { PageHeader } from '@/components/workspace/parts';
import { DEFAULT_PASSWORD_POLICY } from '@trustwork/contracts/client';
import { DATA_SOURCE, data } from '@/app/_lib/data';
import { SecurityPanel, type LiveSession } from './_components/SecurityPanel';
import { SecondFactorPanel } from './_components/SecondFactorPanel';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { longDate, t } from '@/app/_lib/i18n';
import { typo } from '@/app/_lib/typo';
import { primeLocale } from '@/app/_lib/locale';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('settings.title') };
}

const SECTIONS = ['account', 'security', 'preferences', 'channels', 'billing'] as const;

/**
 * Settings entry reached from the avatar menu (never the sidebar): account, security and sessions, preferences, channels, billing state.
 * Live API (WEB-004): the session list, ending sessions and the password change work through `/v1/me/*` (step-up where
 * the API asks for it); two-step verification (BE-004) lives next to them; the demo shows the example list with
 * disabled controls.
 */
export default async function SettingsPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, '/app/settings');
  const s = await data.getSettings(principal);
  const live = DATA_SOURCE === 'api';
  const liveSessions: LiveSession[] = s.sessions.flatMap((x) => (x.id ? [{ id: x.id, device: x.device, location: x.location, lastSeen: x.lastSeen, isCurrent: x.isCurrent }] : []));
  return (
    <>
      <PageHeader title={t('settings.title')} lede={t('settings.lede')} />
      <div className="ws-settings">
        <nav className="ws-settings__nav" aria-label={t('settings.nav.label')}>
          {SECTIONS.map((key) => (
            <a key={key} href={`#${key}`} className="ws-settings__link">
              {t(`settings.nav.${key}`)}
            </a>
          ))}
          <NextLink href={hrefFor(principal, '/app/me')} className="ws-settings__link ws-settings__link--out">
            {t('settings.profileLink')}
            <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
          </NextLink>
        </nav>
        <div className="ws-section" style={{ gap: 24, maxWidth: '52rem' }}>
          <section id="account" aria-labelledby="s-account" className="ws-card">
            <h2 id="s-account" className="ws-h2">
              <Mail size={18} strokeWidth={2} aria-hidden="true" />
              {t('settings.nav.account')}
            </h2>
            <dl className="ws-facts">
              <div>
                <dt>{t('settings.account.name')}</dt>
                <dd>{s.name}</dd>
              </div>
              <div>
                <dt>{t('settings.account.email')}</dt>
                <dd>{s.email}</dd>
              </div>
              <div>
                <dt>{t('settings.account.languageLabel')}</dt>
                <dd>{t('settings.account.languageValue')}</dd>
              </div>
            </dl>
            <div className="ws-actions">
              <Button variant="secondary" isDisabled>
                {t('settings.account.changeEmail')}
              </Button>
              <Button variant="danger" isDisabled>
                {t('settings.account.deleteAccount')}
              </Button>
            </div>
            <p className="ws-note">{live ? t('settings.account.liveNote') : t('settings.account.demoNote')}</p>
          </section>

          <section id="security" aria-labelledby="s-security" className="ws-card">
            <h2 id="s-security" className="ws-h2">
              <ShieldCheck size={18} strokeWidth={2} aria-hidden="true" />
              {t('settings.nav.security')}
            </h2>
            <h3 className="ws-head__kicker">{t('settings.security.providers')}</h3>
            <ul className="ws-list">
              {(
                [
                  { key: 'password', label: t('settings.security.password'), on: s.providers.password },
                  { key: 'apple', label: t('settings.security.apple'), on: s.providers.apple },
                  { key: 'google', label: t('settings.security.google'), on: s.providers.google },
                ] as const
              ).map((p) => (
                <li key={p.key} className="ws-row">
                  <span className="ws-row__main ws-row__main--icon">
                    <span className="ws-mark ws-mark--file" aria-hidden="true">
                      <KeyRound size={16} strokeWidth={2} />
                    </span>
                    <span>
                      <span className="ws-row__title">{p.label}</span>
                      <span className="ws-row__meta">
                        <StatusChip size="sm" tone={p.on ? 'success' : 'neutral'}>
                          {p.on ? t('common.on') : t('settings.security.notLinked')}
                        </StatusChip>
                      </span>
                    </span>
                  </span>
                  {live && p.key === 'password' ? null : (
                    <span className="ws-row__side">
                      <Button variant="secondary" size="sm" isDisabled>
                        {p.key === 'password' ? t('settings.security.changePassword') : p.on ? t('settings.security.unlink') : t('settings.security.link')}
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {live ? (
              <>
                <h3 className="ws-head__kicker">{t('settings.secondFactor.title')}</h3>
                <SecondFactorPanel />
              </>
            ) : null}
            <h3 className="ws-head__kicker">{t('settings.security.sessions')}</h3>
            {live ? <SecurityPanel sessions={liveSessions} minPassword={DEFAULT_PASSWORD_POLICY.minLength} /> : null}
            {live ? null : (
            <>
            <ul className="ws-list">
              {s.sessions.map((session, i) => (
                <li key={i} className="ws-row">
                  <span className="ws-row__main ws-row__main--icon">
                    <span className="ws-mark ws-mark--file" aria-hidden="true">
                      {/iphone|android|телефон/i.test(session.device) ? <Smartphone size={16} strokeWidth={2} /> : <Laptop size={16} strokeWidth={2} />}
                    </span>
                    <span>
                      <span className="ws-row__title">{session.device}</span>
                      <span className="ws-row__meta">
                        {session.isCurrent ? (
                          <StatusChip size="sm" tone="info">
                            {t('settings.security.currentSession')}
                          </StatusChip>
                        ) : null}
                        <span>{session.location}</span>
                        <span>{t('settings.security.lastSeenAt', { date: longDate(session.lastSeen) })}</span>
                      </span>
                    </span>
                  </span>
                  {!session.isCurrent ? (
                    <span className="ws-row__side">
                      <Button variant="ghost" size="sm" isDisabled>
                        {t('settings.security.endSession')}
                      </Button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="ws-actions">
              <Button variant="secondary" isDisabled>
                {t('settings.security.endOthers')}
              </Button>
            </div>
            <p className="ws-note">{t('settings.security.demoSession')}</p>
            </>
            )}
          </section>

          <section id="preferences" aria-labelledby="s-preferences" className="ws-card">
            <h2 id="s-preferences" className="ws-h2">
              {t('settings.nav.preferences')}
            </h2>
            <p className="ws-muted">
              {typo(t('settings.preferences.interestsHint'))}{' '}
              <NextLink href={hrefFor(principal, '/onboarding')} className="ws-more">
                {t('settings.preferences.interests')}
              </NextLink>
            </p>
            <SettingsPreferences pinned={s.pinned} />
          </section>

          <section id="channels" aria-labelledby="s-channels" className="ws-card">
            <h2 id="s-channels" className="ws-h2">
              {t('settings.nav.channels')}
            </h2>
            <div className="ws-empty">
              <strong>{t('settings.channels.empty')}</strong>
              <span>{typo(t('settings.channels.untrustedNote'))}</span>
            </div>
          </section>

          <section id="billing" aria-labelledby="s-billing" className="ws-card">
            <h2 id="s-billing" className="ws-h2">
              {t('settings.nav.billing')}
            </h2>
            <dl className="ws-facts">
              <div>
                <dt>{t('settings.billing.currentPlan')}</dt>
                <dd>{t('settings.billing.free')}</dd>
              </div>
              <div>
                <dt>{t('settings.billing.acceptedOffers')}</dt>
                <dd>{t('settings.billing.noneAccepted')}</dd>
              </div>
              <div>
                <dt>{t('settings.billing.invoices')}</dt>
                <dd>{t('settings.billing.noInvoices')}</dd>
              </div>
            </dl>
            <p className="ws-muted">{typo(t('settings.billing.noOffers'))}</p>
            {s.canSeeCompanyBilling ? (
              <NextLink href={hrefFor(principal, '/app/company#settings')} className="ws-more">
                {t('settings.billing.companyBilling')}
                <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
              </NextLink>
            ) : null}
          </section>
        </div>
      </div>
    </>
  );
}
