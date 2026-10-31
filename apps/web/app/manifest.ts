import type { MetadataRoute } from 'next';
import { t } from '@/app/_lib/i18n';
import { withBase } from '@/app/_lib/base-path';

/** Web app manifest: brand mark icons (three blue squares), Russian name, brand colours. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: t('brand.name'),
    short_name: t('brand.name'),
    description: t('publicShell.tagline'),
    lang: 'ru',
    start_url: withBase('/'),
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#0f1f3d',
    icons: [
      { src: withBase('/icons/icon-192.png'), sizes: '192x192', type: 'image/png' },
      { src: withBase('/icons/icon-512.png'), sizes: '512x512', type: 'image/png' },
      { src: withBase('/icons/icon-512-maskable.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
