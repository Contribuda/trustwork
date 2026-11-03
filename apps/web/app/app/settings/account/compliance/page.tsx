import type { Metadata } from 'next';
import Link from '@/components/locale/LocalLink';
import { PageHeader } from '@/components/workspace/parts';
import { primeLocale } from '@/app/_lib/locale';
import { t } from '@/app/_lib/i18n';
import { requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { demoModeEnabled } from '@/app/_lib/persona';
import { ComplianceForm } from './ComplianceForm';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('compliance.title'), robots: { index: false, follow: false } };
}

export default async function CompliancePage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, '/app/settings/account/compliance');
  const live = !demoModeEnabled();
  const company = live && principal.company?.role === 'administrator' ? principal.company : null;
  return <>
    <PageHeader title={t('compliance.title')} lede={t('compliance.generic')} />
    <div className="ws-section" style={{ maxWidth: '44rem', gap: 20 }}>
      <ComplianceForm live={live} />
      {company ? <ComplianceForm live={live} company={{ id: company.id, title: t('compliance.companyAppealTitle', { company: company.name }) }} /> : null}
      <p className="ws-note">{t('compliance.reviewNotice')}</p>
      <nav aria-label={t('compliance.title')} style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        <Link href="/legal/terms">{t('compliance.terms')}</Link>
        <Link href="/legal/privacy">{t('compliance.privacy')}</Link>
        <Link href="/app/settings">{t('compliance.back')}</Link>
      </nav>
    </div>
  </>;
}
