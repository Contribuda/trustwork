import type { Metadata } from 'next';
import NextLink from '@/components/locale/LocalLink';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { payAction } from '../register/actions';
import { data } from '@/app/_lib/data';
import { dateRangeLabel, decodeTicket } from '@/app/_lib/events';
import { formatMoney, t } from '@/app/_lib/i18n';
import { currencyCode } from '@/app/_lib/country';
import type { PageSearchParams } from '@/app/_lib/principal';
import { typo } from '@/app/_lib/typo';
import { primePublicLocale } from '@/app/_lib/locale';
import { localPath } from '@/app/_lib/localize';

/** Per request: the visitor's own registration, payment or ticket (query), never cached (WEB-005). */
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ lang: string; slug: string }>; searchParams: PageSearchParams };

export async function generateMetadata({ params }: { params: Promise<{ lang: string }> }): Promise<Metadata> {
  await primePublicLocale((await params).lang);
  return { title: t('events.payTitle') };
}

/** Demo payment page: order summary and a button that imitates a successful payment. No provider is connected. */
export default async function PayPage({ params, searchParams }: Props) {
  await primePublicLocale((await params).lang);
  const { slug } = await params;
  const sp = await searchParams;
  const event = await data.getEvent(slug);
  if (!event) notFound();
  const token = typeof sp.t === 'string' ? sp.t : '';
  const parsed = decodeTicket(token);
  const ticket = parsed ? event.tickets.find((tk) => tk.id === parsed.ticketId) : undefined;
  if (!parsed || parsed.slug !== slug || !ticket) redirect(localPath(event.href));
  const total = ticket!.priceMinorUnits * parsed!.qty;

  return (
    <div className="pub pub-page">
      <div className="pub-wrap">
        <NextLink href={`/events/${slug}/register?ticket=${ticket!.id}`} className="pub-back pub-back--always">
          <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
          {t('events.regTitle')}
        </NextLink>
        <div className="ev-reg">
          <section className="ev-reg__form" aria-labelledby="pay-title">
            <h1 className="pub-h1" id="pay-title">
              {t('events.payTitle')}
            </h1>
            <p className="pub-lede">{typo(t('events.payLede'))}</p>
            <div className="art-correction" role="note">
              <ShieldAlert size={16} strokeWidth={2} aria-hidden="true" /> {t('events.payDemoNote')}
            </div>
            <form action={payAction} className="ev-form">
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="lang" value={(await params).lang} />
              <input type="hidden" name="t" value={token} />
              <div className="pub-actions">
                <button type="submit" className="pub-btn pub-btn--dark">
                  {t('events.payButton')} · {formatMoney(String(total), currencyCode())}
                </button>
              </div>
            </form>
          </section>
          <aside className="ev-reg__summary">
            <div className="pub-note">
              <span className="pub-kicker">{t('events.paySummary')}</span>
              <p className="ev-reg__event">{typo(event.title)}</p>
              <dl className="art-facts">
                <div>
                  <dt>{t('events.when')}</dt>
                  <dd>{dateRangeLabel(event.startsAt, event.endsAt, event.timezone)}</dd>
                </div>
                <div>
                  <dt>{t('events.regTicket')}</dt>
                  <dd>
                    {ticket!.name} × {parsed!.qty}
                  </dd>
                </div>
                <div>
                  <dt>{t('events.ticketHolder')}</dt>
                  <dd>{parsed!.name}</dd>
                </div>
                <div>
                  <dt>{t('events.regTotal')}</dt>
                  <dd>{formatMoney(String(total), currencyCode())}</dd>
                </div>
              </dl>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
