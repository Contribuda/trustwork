import type { Metadata } from 'next';
import { Breadcrumb } from '@/components/ui';
import { PageHeader } from '@/components/workspace/parts';
import { COMMERCE_DEMO } from '@/components/commerce/data';
import { NeedForm } from '@/components/commerce/need-form';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';
import '@/components/commerce/commerce.css';

export async function generateMetadata(): Promise<Metadata> {
  await primeLocale();
  return { title: t('commerce.need.newTitle') };
}

/** Intake of a new need, typed in by the person (journey 3). A need is owner-private until it becomes an RFQ and is published. */
export default async function NewNeedPage({ searchParams }: { searchParams: PageSearchParams }) {
  await primeLocale();
  const principal = await requirePrincipal(searchParams, '/app/procurement/needs/new');
  return (
    <>
      <PageHeader title={t('commerce.need.newTitle')} lede={t('commerce.need.newLede')}>
        <Breadcrumb items={[{ id: 'procurement', label: t('procurement.title'), href: hrefFor(principal, '/app/procurement') }, { id: 'new', label: t('commerce.need.newTitle') }]} />
      </PageHeader>
      {COMMERCE_DEMO ? <p className="ws-note">{t('commerce.demoNote')}</p> : null}
      <div style={{ maxWidth: '48rem' }}>
        <NeedForm principal={principal} need={null} demo={COMMERCE_DEMO} />
      </div>
    </>
  );
}
