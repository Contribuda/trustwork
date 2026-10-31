'use client';

import { useEffect, useState } from 'react';
import { Check, Link2, Send } from 'lucide-react';
import { t } from '@/app/_lib/i18n';

/**
 * Share controls for a public material: copy the canonical link (clipboard, with a two-second confirmation),
 * A Telegram share link. No tracking, no third-party scripts; the share links are plain URLs.
 */
export function ShareRow({ path, title }: { path: string; title: string }) {
  const [url, setUrl] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setUrl(`${window.location.origin}${path}`);
  }, [path]);
  useEffect(() => {
    if (!copied) return;
    const handle = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(handle);
  }, [copied]);
  const encoded = encodeURIComponent(url || path);
  const encodedTitle = encodeURIComponent(title);
  return (
    <div className="share" role="group" aria-label={t('detail.share')}>
      <button
        type="button"
        className="share__btn"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url || path);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
        aria-live="polite"
      >
        {copied ? <Check size={16} strokeWidth={2} aria-hidden="true" /> : <Link2 size={16} strokeWidth={2} aria-hidden="true" />}
        {copied ? t('detail.copied') : t('detail.copyLink')}
      </button>
      <a className="share__btn" href={`https://t.me/share/url?url=${encoded}&text=${encodedTitle}`} target="_blank" rel="noopener noreferrer">
        <Send size={16} strokeWidth={2} aria-hidden="true" />
        {t('detail.shareTelegram')}
      </a>
    </div>
  );
}
