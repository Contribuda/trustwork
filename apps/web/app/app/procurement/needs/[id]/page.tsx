import type { Metadata } from 'next';
import NextLink from '@/components/locale/LocalLink';
import { notFound } from 'next/navigation';
import { Breadcrumb } from '@/components/ui';
import { PageHeader } from '@/components/workspace/parts';
import { commerce, COMMERCE_DEMO } from '@/components/commerce/data';
import { ConvertNeedForm, NeedForm } from '@/components/commerce/need-form';
import { LinesTable, NeedStatus, PrivateLabel } from '@/components/commerce/parts';
import { currencyCode } from '@/app/_lib/country';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { shortDate, t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

type Params = { params: Promise<{ id: string }>; searchParams: PageSearchParams };

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  await primeLocale();
  const { id } = await params;
  const principal = await requirePrincipal(searchParams, `/app/procurement/needs/${id}`);
  const need = await commerce.getNeed(principal, id);
  return { title: need ? need.title : t('ws.notFoundTitle') };
}

/** Clarification of one missing field as a question the person can answer in the form below. */
function missingLabel(code: string): string {
  const line = /^lines\.(\d+)\.(kind|quantity)$/.exec(code);
  if (line) return t(line[2] === 'kind' ? 'commerce.missing.kind' : 'commerce.missing.quantity', { n: Number(line[1]) + 1 });
  if (code === 'lines') return t('commerce.missing.lines');
  if (code === 'region') return t('commerce.missing.region');
  if (code === 'window') return t('commerce.missing.window');
  if (code === 'acceptanceCriteria') return t('commerce.missing.acceptance');
  return code;
}

/**
 * One need (journey 3): what is still missing before suppliers can be asked (scope, kind, quantity and unit, place,
 * timing, acceptance), the clarification form, and the conversion into an RFQ draft once nothing is missing. Someone
 * without rights on the need gets 404.
 */
export default async function NeedPage({ params, searchParams }: Params) {
  await primeLocale();
  const { id } = await params;
  const principal = await requirePrincipal(searchParams, `/app/procurement/needs/${id}`);
  const need = await commerce.getNeed(principal, id);
  if (!need) notFound();
  const converted = need.status === 'converted';
  return (
    <>
      <PageHeader title={need.title} lede={t('commerce.need.lede', { date: shortDate(need.updatedAt) })}>
        <Breadcrumb items={[{ id: 'procurement', label: t('procurement.title'), href: hrefFor(principal, '/app/procurement') }, { id: 'need', label: need.title }]} />
      </PageHeader>
      <p className="cm-actions" style={{ marginBottom: 16 }}>
        <NeedStatus status={need.status} />
        <PrivateLabel>{t('commerce.need.privateNote')}</PrivateLabel>
      </p>
      {converted && need.rfqId ? (
        <p className="banner" role="status">
          {t('commerce.need.converted')}{' '}
          <NextLink href={hrefFor(principal, `/app/procurement/rfq/${encodeURIComponent(need.rfqId)}`)}>{t('commerce.need.openRfq')}</NextLink>
        </p>
      ) : null}
      <div className="ws-grid ws-grid--main">
        <div className="ws-section">
          {converted ? (
            <LinesTable lines={need.lines} caption={t('commerce.lines.title')} />
          ) : (
            <NeedForm principal={principal} need={need} demo={COMMERCE_DEMO} />
          )}
        </div>
        <div className="ws-section">
          <section className="ws-card" aria-labelledby="missing-title">
            <h2 id="missing-title" className="ws-h2">
              {t('commerce.need.missingTitle')}
            </h2>
            {need.missingFields.length ? (
              <ul className="cm-checklist">
                {need.missingFields.map((code) => (
                  <li key={code}>{missingLabel(code)}</li>
                ))}
              </ul>
            ) : (
              <p className="ws-muted">{t('commerce.need.nothingMissing')}</p>
            )}
          </section>
          {need.status === 'ready' ? (
            <section className="ws-card" aria-labelledby="convert-title">
              <h2 id="convert-title" className="ws-h2">
                {t('commerce.convert.title')}
              </h2>
              <p className="ws-muted">{t('commerce.convert.body')}</p>
              <ConvertNeedForm needId={need.id} revision={need.revision} currency={currencyCode()} demo={COMMERCE_DEMO} />
            </section>
          ) : !converted ? (
            <p className="ws-note">{t('commerce.convert.notReady')}</p>
          ) : null}
        </div>
      </div>
    </>
  );
}
