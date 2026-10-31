'use client';

import { t } from '@/app/_lib/i18n';

function AppleMark() {
  return (
    <svg className="au-provider__mark" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="currentColor" d="M16.4 12.7c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.3 1.2 9.7.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.2-.8s1.9.8 3.2.8c1.3 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.3-2.8-.1 0-2.6-1-2.6-3.8zM14 5.5c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.9-1 2.9 1.1.1 2.1-.5 2.8-1.4z" />
    </svg>
  );
}

function GoogleMark() {
  return (
    <svg className="au-provider__mark" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5c-.3 1.5-1.1 2.7-2.4 3.6v3h3.9c2.3-2.1 3.5-5.1 3.5-8.7z" />
      <path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.7-4.9H1.3v3.1C3.3 21.4 7.3 24 12 24z" />
      <path fill="#FBBC05" d="M5.3 14.4c-.2-.7-.4-1.5-.4-2.4s.1-1.6.4-2.4V6.5H1.3C.5 8.2 0 10 0 12s.5 3.8 1.3 5.5l4-3.1z" />
      <path fill="#EA4335" d="M12 4.7c1.8 0 3.3.6 4.6 1.8l3.4-3.4C17.9 1.2 15.2 0 12 0 7.3 0 3.3 2.6 1.3 6.5l4 3.1C6.3 6.8 8.9 4.7 12 4.7z" />
    </svg>
  );
}

/**
 * Apple and Google sign-in alternatives behind the neutral identity adapter (R21, ADR-009). The providers are not connected in the demo: the buttons stay
 * disabled with an explicit note instead of pretending to work.
 */
export function ProviderButtons({ mode }: { mode: 'login' | 'signup' }) {
  return (
    <div className="au-providers">
      <button type="button" className="au-provider" disabled aria-describedby="au-providers-note">
        <AppleMark />
        {t(mode === 'login' ? 'auth.apple' : 'auth.appleContinue')}
      </button>
      <button type="button" className="au-provider" disabled aria-describedby="au-providers-note">
        <GoogleMark />
        {t(mode === 'login' ? 'auth.google' : 'auth.googleContinue')}
      </button>
      <p id="au-providers-note" className="au-providers__note">
        {t('auth.providersUnavailable')}
      </p>
    </div>
  );
}
