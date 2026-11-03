import type { Metadata } from 'next';
import Link from '@/components/locale/LocalLink';
import { PageHeader } from '@/components/workspace/parts';
import { primeLocale } from '@/app/_lib/locale';
import { t } from '@/app/_lib/i18n';
import { requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { demoModeEnabled } from '@/app/_lib/persona';
import { createTransport } from '@/app/_lib/data/http/transport';
import { ComplianceForm } from './ComplianceForm';

const PATH = '/app/settings/account/compliance';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('compliance.title'), robots: { index: false, follow: false } };
}

/** Whether an appeal is open, or null when the API gave no answer. Only this eligibility is read: the page shows no status. */
async function appealOpen(path: `/v1/${string}`): Promise<boolean | null> {
  try {
    const own = await createTransport().get(path) as { canAppeal?: unknown } | null;
    return typeof own?.canAppeal === 'boolean' ? own.canAppeal : null;
  } catch {
    return null;
  }
}

export default async function CompliancePage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, PATH);
  const live = !demoModeEnabled();
  const company = live && principal.company?.role === 'administrator' ? principal.company : null;
  const own = live ? await appealOpen('/v1/screening/me') : null;
  const forCompany = company ? await appealOpen(`/v1/screening/me?companyId=${company.id}`) : false;
  return <>
    <PageHeader title={t('compliance.title')} lede={t('compliance.generic')} />
    <div className="ws-section" style={{ maxWidth: '44rem', gap: 20 }}>
      {own === null || forCompany === null ? <>
        <p role="alert">{t('compliance.unavailable')}</p>
        {live ? <Link href={PATH}>{t('compliance.retry')}</Link> : null}
      </> : null}
      {own ? <ComplianceForm title={t('compliance.appealTitle')} /> : null}
      {company && forCompany ? <ComplianceForm title={t('compliance.companyAppealTitle', { company: company.name })} companyId={company.id} /> : null}
      <p className="ws-note">{t('compliance.reviewNotice')}</p>
      <nav aria-label={t('compliance.title')} style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        <Link href="/legal/terms">{t('compliance.terms')}</Link>
        <Link href="/legal/privacy">{t('compliance.privacy')}</Link>
        <Link href="/app/settings">{t('compliance.back')}</Link>
      </nav>
    </div>
  </>;
}
