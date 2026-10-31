import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import './admin.css';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: { default: t('admin.title'), template: `%s — ${t('admin.title')}` }, robots: { index: false, follow: false } };
}

/**
 * The hub console segment (ADM-002). Private, rendered per request, never indexed. The layout holds no viewer logic:
 * layouts cannot read the URL, so each page resolves its viewer, hub and section itself (`HubConsolePage`) and
 * renders the shell. With demo mode off there is no console backend yet, so every page is "not found".
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return children;
}
