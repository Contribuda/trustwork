'use client';

import { t } from '@/app/_lib/i18n';

/** Policy-first estimate: length is what the contract enforces; variety only adds advice, never blocks. */
export function passwordScore(password: string, min: number): { level: 0 | 1 | 2 | 3 | 4; tips: string[] } {
  if (!password) return { level: 0, tips: [] };
  const tips: string[] = [];
  let level = 0;
  if (password.length >= min) level += 2;
  else tips.push(t('auth.strength.tipLength', { min }));
  if (password.length >= min + 6) level += 1;
  const kinds = [/[a-zа-яё]/i.test(password), /\d/.test(password), /[^\p{L}\d]/u.test(password), /\s/.test(password)].filter(Boolean).length;
  if (kinds >= 2) level += 1;
  else tips.push(t('auth.strength.tipMix'));
  if (/^(.)\1+$/.test(password) || /^(1234|qwer|пароль|password)/i.test(password)) {
    level = Math.min(level, 1);
    tips.push(t('auth.strength.tipCommon'));
  }
  return { level: Math.min(4, Math.max(1, level)) as 1 | 2 | 3 | 4, tips };
}

const LABELS = ['', 'auth.strength.weak', 'auth.strength.fair', 'auth.strength.good', 'auth.strength.strong'] as const;

/** Four-segment meter with a text label and up to two tips; announced politely, never an error. */
export function PasswordStrength({ password, min }: { password: string; min: number }) {
  const { level, tips } = passwordScore(password, min);
  if (!password) return null;
  return (
    <div className="au-strength" aria-live="polite">
      <div className={`au-strength__bars au-strength__bars--${level}`} aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <p className="au-strength__label">
        {t('auth.strength.label')}: <strong>{t(LABELS[level] as 'auth.strength.weak')}</strong>
        {tips.length ? ` · ${tips.slice(0, 2).join(' ')}` : ''}
      </p>
    </div>
  );
}
