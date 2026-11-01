import type { Metadata } from 'next';
import type { PublicPricing } from '@trustwork/contracts/client';
import { data } from '@/app/_lib/data';
import { currentLocale, formatMoney, formatNumber, t } from '@/app/_lib/i18n';
import { primePublicLocale } from '@/app/_lib/locale';
import { languageAlternates } from '@/app/_lib/site';
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
export default async function PricingPage({ params }: Props) {
  await primePublicLocale((await params).lang);
  let pricing: PublicPricing | null = null;
  try { pricing = await data.getPublicPricing(); } catch { /* A failed read is visibly distinct from an empty catalogue. */ }
  return <div className="pub pub-page"><article className="pub-wrap fee-pricing">
    <h1 className="pub-h1">{t('pricing.title')}</h1>
    <p className="pub-lede">{t('pricing.intro')}</p>
    <aside className="fee-pricing-policy"><h2>{t('pricing.neutralTitle')}</h2><p>{t('pricing.neutral')}</p><p>{t('pricing.custody')}</p></aside>
    {!pricing ? <p role="alert">{t('pricing.error')}</p> : <>
      <section aria-labelledby="fee-heading"><h2 id="fee-heading">{t('pricing.fees')}</h2>
        {pricing.fees.length === 0 ? <p>{t('pricing.empty')}</p> : <ul className="fee-pricing-list">{pricing.fees.map((fee) => <li key={fee.id}>
          <h3>{t(`pricing.kind.${fee.terms.kind}`)} · {t(`pricing.payer.${fee.terms.payer}`)}</h3>
          <p>{t('pricing.version', { version: formatNumber(fee.version) })}</p>
          {fee.terms.categoryKey ? <p>{t('pricing.category', { category: fee.terms.categoryKey })}</p> : <p>{t('pricing.allCategories')}</p>}
          <p className="fee-pricing-amount">
            {fee.terms.basisPoints !== null ? new Intl.NumberFormat(currentLocale(), { style: 'percent', maximumFractionDigits: 2 }).format(fee.terms.basisPoints / 10000) : null}
            {fee.terms.basisPoints !== null && fee.terms.fixedMinor !== null ? ' + ' : null}
            {fee.terms.fixedMinor !== null ? formatMoney(fee.terms.fixedMinor, fee.terms.currency) : null}
          </p>
          <Validity from={fee.terms.effectiveFrom} to={fee.terms.effectiveTo} />
          <p className="fee-pricing-reference">{t('pricing.reference', { reference: fee.id })}</p>
        </li>)}</ul>}
      </section>
      <section aria-labelledby="price-heading"><h2 id="price-heading">{t('pricing.prices')}</h2>
        {pricing.prices.length === 0 ? <p>{t('pricing.empty')}</p> : <ul className="fee-pricing-list">{pricing.prices.map((price) => <li key={price.id}>
          <h3>{t(`pricing.kind.${price.kind}`)}</h3><p>{price.code}</p>
          <p>{t('pricing.version', { version: formatNumber(price.version) })}</p>
          {price.planVersion ? <p>{t('pricing.planVersion', { version: formatNumber(price.planVersion.version) })}</p> : null}
          <p className="fee-pricing-amount">{formatMoney(price.amountMinor, price.currency)}</p>
          <Validity from={price.effectiveFrom} to={price.effectiveTo} />
          {price.validity ? <p>{t('pricing.packValidity', { validity: price.validity })}</p> : null}
        </li>)}</ul>}
      </section>
      {pricing.unavailable.length ? <section><h2>{t('pricing.unavailable')}</h2><ul>{pricing.unavailable.map((kind) => <li key={kind}>{t(`pricing.unavailableKinds.${kind}`)}</li>)}</ul><p>{t('pricing.noZero')}</p></section> : null}
    </>}
  </article></div>;
}
