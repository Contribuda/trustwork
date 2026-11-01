import { Suspense } from 'react';
import type { Metadata } from 'next';
import type { PublicPricing } from '@trustwork/contracts/client';
import { data } from '@/app/_lib/data';
import { currentLocale, formatNumber, t } from '@/app/_lib/i18n';
import { primePublicLocale } from '@/app/_lib/locale';
import { localHref } from '@/app/_lib/localize';
import { languageAlternates } from '@/app/_lib/site';
import { publicFeeCategory } from './categories';
import { exactPrice } from './money';
import { PRICE_SECTIONS, pricingView, type PriceRow, type PriceSection } from './view';
import './pricing.css';

type Props = { params: Promise<{ lang: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang } = await params;
  await primePublicLocale(lang);
  return { title: t('pricing.title'), alternates: languageAlternates('/pricing', lang) };
}
const dateTime = (value: string) => new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'long', timeStyle: 'long', timeZone: 'UTC' }).format(new Date(value));
function Validity({ from, to }: { from: string; to: string | null }) {
  return <p>{t('pricing.validity', { from: dateTime(from), to: to ? dateTime(to) : t('pricing.noEnd') })}</p>;
}
function PriceEntry({ row }: { row: PriceRow }) {
  const fee = row.type === 'fee' ? row.value : null;
  const price = row.type === 'price' ? row.value : null;
  const terms = fee?.terms ?? price!;
  const category = fee ? publicFeeCategory(fee.terms.kind, fee.terms.categoryKey, currentLocale(), t) : null;
  const zero = fee ? (fee.terms.basisPoints ?? 0) === 0 && BigInt(fee.terms.fixedMinor ?? '0') === 0n : BigInt(price!.amountMinor) === 0n;
  return <tr className="fee-pricing-row" role="row">
    <th scope="row" role="rowheader">
      <h4>{t(`pricing.kind.${terms.kind}`)}</h4>
      {fee ? <><p>{category === null ? t('pricing.categoryUnavailable') : t('pricing.category', { category })}</p><p>{t(`pricing.payer.${fee.terms.payer}`)}</p></>
        : <p>{price?.disclosure?.name ?? t('pricing.catalogue.offerUnknown')}</p>}
    </th>
    <td role="cell">
      <span className="fee-pricing-mobile-label">{t('pricing.catalogue.amount')}</span>
      <p className="fee-pricing-amount">{fee ? <>
        {fee.terms.basisPoints !== null ? new Intl.NumberFormat(currentLocale(), { style: 'percent', maximumFractionDigits: 2 }).format(fee.terms.basisPoints / 10000) : null}
        {fee.terms.basisPoints !== null && fee.terms.fixedMinor !== null ? ' + ' : null}
        {fee.terms.fixedMinor !== null ? exactPrice(fee.terms.fixedMinor, fee.terms.currency, currentLocale()) : null}
      </> : exactPrice(price!.amountMinor, price!.currency, currentLocale())}</p>
      <p>{t('pricing.catalogue.currency', { currency: terms.currency })}</p>
      {zero ? <p className="fee-pricing-state">{t('pricing.catalogue.zero')}</p> : null}
      <p>{t(fee ? 'pricing.catalogue.feeUnit' : 'pricing.catalogue.unitUnknown')}</p>
    </td>
    <td role="cell">
      <span className="fee-pricing-mobile-label">{t('pricing.catalogue.conditions')}</span>
      <p>{t('pricing.version', { version: formatNumber(row.value.version) })}</p>
      <Validity from={terms.effectiveFrom} to={terms.effectiveTo} />
      {price?.planVersion ? <><p>{t('pricing.planVersion', { version: formatNumber(price.planVersion.version) })}</p>{price.disclosure?.plan ? <PlanDetails plan={price.disclosure.plan} /> : <p>{t('pricing.catalogue.capacityUnknown')}</p>}</> : null}
      {price?.validity ? <p>{t('pricing.packValidity', { validity: price.validity })}</p> : null}
      <details className="fee-pricing-reference">
        <summary>{t('pricing.details')}</summary>
        <p>{t('pricing.reference', { reference: row.value.id })}</p>
        {fee ? <><p>{t('pricing.digest', { digest: fee.digest })}</p><p>{t('pricing.catalogue.acceptance', { version: fee.terms.acceptanceTextVersion })}</p>
          {fee.terms.categoryKey ? <p>{t('pricing.catalogue.scope', { scope: fee.terms.categoryKey })}</p> : null}</> : <>
          <p>{t('pricing.catalogue.scope', { scope: price!.code })}</p>
          {price?.disclosure ? <><p>{t('pricing.reference', { reference: price.disclosure.offerId })}</p><p>{t('pricing.catalogue.acceptance', { version: price.disclosure.acceptanceTextVersion })}</p></> : null}
          {price?.planVersion ? <p>{t('pricing.reference', { reference: price.planVersion.id })}</p> : null}
        </>}
      </details>
    </td>
  </tr>;
}
function PlanDetails({ plan }: { plan: NonNullable<NonNullable<PublicPricing['prices'][number]['disclosure']>['plan']> }) {
  return <div className="fee-pricing-plan">
    <p>{t(`pricing.catalogue.payer.${plan.payerKind}`)}</p>
    <p>{t('pricing.catalogue.connections', { count: formatNumber(plan.connections) })}</p>
    <p>{t('pricing.catalogue.channels', { count: formatNumber(plan.channels) })}</p>
    <p>{t(plan.representativeIncluded ? 'pricing.catalogue.representativeYes' : 'pricing.catalogue.representativeNo')}</p>
    <p>{t('pricing.catalogue.modules', { modules: plan.moduleKeys.join(', ') })}</p>
    {plan.includedQuota.length ? <ul>{plan.includedQuota.map(q => <li key={`${q.moduleKey}/${q.meter}/${q.window}`}>
      {t('pricing.catalogue.quota', { module: q.moduleKey, meter: q.meter, units: new Intl.NumberFormat(currentLocale()).format(BigInt(q.units)), window: q.window })}
    </li>)}</ul> : <p>{t('pricing.catalogue.noQuota')}</p>}
  </div>;
}
function PriceTable({ rows, section, future }: { rows: PriceRow[]; section: PriceSection; future: boolean }) {
  if (!rows.length) return null;
  const heading = `pricing-${section}-${future ? 'future' : 'current'}`;
  return <div className="fee-pricing-group">
    <h3 id={heading}>{t(future ? 'pricing.catalogue.future' : 'pricing.catalogue.current')}</h3>
    <table className="fee-pricing-table" role="table" aria-labelledby={`pricing-${section} ${heading}`}>
      <thead role="rowgroup"><tr role="row">
        <th scope="col" role="columnheader">{t('pricing.catalogue.offer')}</th>
        <th scope="col" role="columnheader">{t('pricing.catalogue.amount')}</th>
        <th scope="col" role="columnheader">{t('pricing.catalogue.conditions')}</th>
      </tr></thead>
      <tbody role="rowgroup">{rows.map(row => <PriceEntry key={row.value.id} row={row} />)}</tbody>
    </table>
  </div>;
}
async function Catalogue() {
  let pricing: PublicPricing | null = null;
  try { pricing = await data.getPublicPricing(); } catch { /* Failed reads remain errors, never successful empty catalogues. */ }
  const view = pricingView(pricing, new Date().toISOString());
  return <>
    <div className="fee-pricing-context">
      <p className="fee-pricing-hub">{view.hubId ? t('pricing.catalogue.hub', { hub: view.hubId }) : t('pricing.catalogue.hubUnknown')}</p>
      {pricing ? <p>{t('pricing.catalogue.asOf', { time: dateTime(view.at) })}</p> : null}
    </div>
    <aside className="fee-pricing-policy">
      <h2>{t('pricing.catalogue.freeTitle')}</h2><p>{t('pricing.catalogue.free')}</p>
      <h2>{t('pricing.neutralTitle')}</h2><p>{t('pricing.neutral')}</p><p>{t('pricing.custody')}</p>
    </aside>
    <nav className="fee-pricing-index" aria-label={t('pricing.catalogue.index')}>
      <ul>{PRICE_SECTIONS.map(key => <li key={key}><a href={`#pricing-${key}`}>{t(`pricing.sections.${key}`)}</a></li>)}</ul>
    </nav>
    <section className="fee-pricing-coverage" aria-labelledby="pricing-coverage">
      <h2 id="pricing-coverage">{t('pricing.catalogue.coverage')}</h2>
      <p role="status" data-pricing-state={view.state}>{view.state === 'error' ? t('pricing.error') : t(`pricing.catalogue.${view.state}`)}</p>
      <p>{t('pricing.noZero')}</p><a className="fee-pricing-retry" href={localHref('/pricing')}>{t('pricing.catalogue.retry')}</a>
    </section>
    {view.sections.map(section => <section key={section.key} aria-labelledby={`pricing-${section.key}`} data-section={section.key} data-coverage={section.state}>
      <h2 id={`pricing-${section.key}`} tabIndex={-1}>{t(`pricing.sections.${section.key}`)}</h2>
      {section.state !== 'available' ? <p>{t(section.state === 'empty' ? 'pricing.catalogue.empty' : section.state === 'error' ? 'pricing.catalogue.failed' : 'pricing.catalogue.unavailable')}</p> : null}
      <PriceTable rows={section.current} section={section.key} future={false} />
      <PriceTable rows={section.future} section={section.key} future />
    </section>)}
    <section aria-labelledby="pricing-sponsorship"><h2 id="pricing-sponsorship">{t('pricing.catalogue.sponsorshipTitle')}</h2><p>{t('pricing.catalogue.sponsorship')}</p></section>
    <aside className="fee-pricing-policy fee-pricing-conditions"><p>{t('pricing.catalogue.termsUnknown')}</p><p>{t('pricing.catalogue.taxUnknown')}</p><p>{t('pricing.catalogue.changed')}</p><p>{t('pricing.catalogue.readOnly')}</p></aside>
  </>;
}
export default async function PricingPage({ params }: Props) {
  await primePublicLocale((await params).lang);
  return <div className="pub pub-page"><article className="pub-wrap fee-pricing">
    <h1 className="pub-h1">{t('pricing.title')}</h1><p className="pub-lede">{t('pricing.intro')}</p>
    <Suspense fallback={<p role="status" aria-busy="true">{t('pricing.catalogue.loading')}</p>}><Catalogue /></Suspense>
  </article></div>;
}
