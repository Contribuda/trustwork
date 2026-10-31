import type { Metadata } from 'next';
import NextLink from '@/components/locale/LocalLink';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { registerAction } from './actions';
import { data } from '@/app/_lib/data';
import { dateRangeLabel, placeLine, priceLabel, timeRangeLabel, typeLabel } from '@/app/_lib/events';
import { formatMoney, t } from '@/app/_lib/i18n';
import { currencyCode } from '@/app/_lib/country';
import type { PageSearchParams } from '@/app/_lib/principal';
import { typo } from '@/app/_lib/typo';
import { primePublicLocale } from '@/app/_lib/locale';

/** Per request: the visitor's own registration, payment or ticket (query), never cached (WEB-005). */
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ lang: string; slug: string }>; searchParams: PageSearchParams };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  await primePublicLocale((await params).lang);
  const { slug } = await params;
  const event = await data.getEvent(slug);
  return { title: event ? `${t('events.regTitle')} — ${event.title}` : t('error.notFoundTitle') };
}

const ERRORS: Record<string, string> = { name: 'events.regErrorName', email: 'events.regErrorEmail', agree: 'events.regErrorAgree', ticket: 'events.regErrorTicket' };

/** Registration form (guest): ticket type, participant, quantity, consent. Server action validates and redirects. */
export default async function RegisterPage({ params, searchParams }: Props) {
  await primePublicLocale((await params).lang);
  const { slug } = await params;
  const sp = await searchParams;
  const event = await data.getEvent(slug);
  if (!event) notFound();
  const wanted = typeof sp.ticket === 'string' ? sp.ticket : undefined;
  const ticket = event.tickets.find((tk) => tk.id === wanted && tk.available) ?? event.tickets.find((tk) => tk.available);
  const error = typeof sp.error === 'string' ? ERRORS[sp.error] : undefined;
  const prev = {
    name: typeof sp.name === 'string' ? sp.name : '',
    email: typeof sp.email === 'string' ? sp.email : '',
    company: typeof sp.company === 'string' ? sp.company : '',
    qty: typeof sp.qty === 'string' ? sp.qty : '1',
  };
  const qty = Math.min(10, Math.max(1, Number.parseInt(prev.qty, 10) || 1));

  return (
    <div className="pub pub-page">
      <div className="pub-wrap">
        <NextLink href={event.href} className="pub-back pub-back--always">
          <ArrowLeft size={16} strokeWidth={2} aria-hidden="true" />
          {t('events.regBack')}
        </NextLink>
        <div className="ev-reg">
          <section className="ev-reg__form" aria-labelledby="reg-title">
            <h1 className="pub-h1" id="reg-title">
              {t('events.regTitle')}
            </h1>
            <p className="pub-lede">{typo(t('events.regLede'))}</p>
            {!ticket ? (
              <p className="art-correction" role="status">
                {t('events.regErrorTicket')}
              </p>
            ) : (
              <form action={registerAction} className="ev-form">
                <input type="hidden" name="slug" value={event.slug} />
                <input type="hidden" name="lang" value={(await params).lang} />
                {error ? (
                  <p className="art-correction" role="alert">
                    {t(error as 'events.regErrorName')}
                  </p>
                ) : null}
                <fieldset className="ev-form__group">
                  <legend className="ev-form__legend">{t('events.regTicket')}</legend>
                  <div className="ev-form__tickets">
                    {event.tickets.map((tk) => (
                      <label key={tk.id} className={tk.available ? 'ev-choice' : 'ev-choice ev-choice--off'}>
                        <input type="radio" name="ticket" value={tk.id} defaultChecked={tk.id === ticket.id} disabled={!tk.available} />
                        <span className="ev-choice__text">
                          <span className="ev-choice__name">{tk.name}</span>
                          <span className="ev-choice__desc">{typo(tk.description)}</span>
                        </span>
                        <span className="ev-choice__price">{priceLabel(tk.priceMinorUnits, false)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="ev-form__grid">
                  <label className="ev-field">
                    <span>{t('events.regName')}</span>
                    <input name="name" type="text" autoComplete="name" required minLength={3} defaultValue={prev.name} />
                  </label>
                  <label className="ev-field">
                    <span>{t('events.regEmail')}</span>
                    <input name="email" type="email" autoComplete="email" required defaultValue={prev.email} />
                  </label>
                  <label className="ev-field">
                    <span>{t('events.regPhone')}</span>
                    <input name="phone" type="tel" autoComplete="tel" inputMode="tel" />
                  </label>
                  <label className="ev-field">
                    <span>{t('events.regCompany')}</span>
                    <input name="company" type="text" autoComplete="organization" defaultValue={prev.company} />
                  </label>
                  <label className="ev-field ev-field--qty">
                    <span>{t('events.regQty')}</span>
                    <input name="qty" type="number" min={1} max={10} defaultValue={qty} />
                  </label>
                </div>
                <label className="ev-agree">
                  <input type="checkbox" name="agree" />
                  <span>{t('events.regAgree')}</span>
                </label>
                <div className="pub-actions">
                  <button type="submit" className="pub-btn pub-btn--dark">
                    {ticket.priceMinorUnits === 0 ? t('events.regSubmitFree') : t('events.regSubmitPaid')}
                  </button>
                </div>
              </form>
            )}
          </section>
          <aside className="ev-reg__summary">
            <div className="pub-note">
              <span className="pub-kicker">{typeLabel(event.type)}</span>
              <p className="ev-reg__event">{typo(event.title)}</p>
              <dl className="art-facts">
                <div>
                  <dt>{t('events.when')}</dt>
                  <dd>
                    {dateRangeLabel(event.startsAt, event.endsAt, event.timezone)}, {timeRangeLabel(event.startsAt, event.endsAt, event.timezone)}
                  </dd>
                </div>
                <div>
                  <dt>{t('events.where')}</dt>
                  <dd>{event.format === 'online' ? t('events.online') : (event.venue?.name ?? placeLine(event))}</dd>
                </div>
                {ticket ? (
                  <div>
                    <dt>{t('events.regTotal')}</dt>
                    <dd>{ticket.priceMinorUnits === 0 ? t('events.free') : formatMoney(String(ticket.priceMinorUnits * qty), currencyCode())}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
