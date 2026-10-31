import type { Metadata } from 'next';
import NextLink from '@/components/locale/LocalLink';
import { notFound, redirect } from 'next/navigation';
import { Breadcrumb } from '@/components/ui';
import { PageHeader } from '@/components/workspace/parts';
import { commerce, COMMERCE_DEMO } from '@/components/commerce/data';
import { ConfirmCommand } from '@/components/commerce/commands';
import { partyLabels } from '@/components/commerce/labels';
import { prefillQuotePayload } from '@/components/commerce/quote-prefill';
import { Digest, InvitationStatus, LinesTable, RfqTerms, StaleChip } from '@/components/commerce/parts';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { shortDate, t } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

type Params = { params: Promise<{ id: string }>; searchParams: PageSearchParams };

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  await primeLocale();
  const { id } = await params;
  const principal = await requirePrincipal(searchParams, `/app/sales/rfq/${id}`);
  const view = await commerce.getRfq(principal, id);
  return { title: view && view.projection === 'shared_party' ? (view.versions.at(-1)?.payload.title ?? t('sales.title')) : t('ws.notFoundTitle') };
}

/**
 * A request as its invited supplier sees it (shared projection): who buys, the versions its own invitations pin, never
 * the buyer's budget, notes, shortlist or other invited suppliers. The supplier records that it has seen or declines
 * the invitation, and prepares a quote prefilled from the pinned version. The buyer side is sent to its procurement
 * page; anyone else gets 404.
 */
export default async function SalesRfqPage({ params, searchParams }: Params) {
  await primeLocale();
  const { id } = await params;
  const principal = await requirePrincipal(searchParams, `/app/sales/rfq/${id}`);
  const view = await commerce.getRfq(principal, id);
  if (!view) notFound();
  if (view.projection === 'owner_private') redirect(hrefFor(principal, `/app/procurement/rfq/${encodeURIComponent(id)}`));
  const quotes = await commerce.listQuotes(principal);
  const quote = quotes.find((q) => q.rfqId === id) ?? null;
  const live = view.invitations.filter((i) => !i.staleReason && i.status !== 'withdrawn' && i.status !== 'declined');
  const invitation = live.at(-1) ?? view.invitations.at(-1)!;
  const version = view.versions.find((v) => v.id === invitation.rfqVersion.id) ?? view.versions.at(-1)!;
  const newest = view.versions.reduce((a, b) => (b.version > a.version ? b : a), view.versions[0]!);
  const label = await partyLabels(principal, [view.rfq.buyer, invitation.party]);
  const href = (path: string) => hrefFor(principal, path);
  const canQuote = !quote && live.length > 0 && view.rfq.status === 'published' && invitation.status !== 'declined';
  return (
    <>
      <PageHeader title={version.payload.title} lede={t('commerce.sales.rfqLede', { buyer: label(view.rfq.buyer), party: label(invitation.party) })}>
        <Breadcrumb items={[{ id: 'sales', label: t('sales.title'), href: href('/app/sales') }, { id: 'rfq', label: version.payload.title }]} />
      </PageHeader>
      {COMMERCE_DEMO ? <p className="ws-note">{t('commerce.demoNote')}</p> : null}
      <p className="cm-actions" style={{ marginBottom: 16 }}>
        <InvitationStatus status={invitation.status} />
        <span>{t('commerce.versionN', { version: version.version })}</span>
        {invitation.staleReason ? <StaleChip version={invitation.rfqVersion.version} /> : null}
        <Digest value={version.digest} />
        <span className="ws-muted">{t('commerce.rfq.deadlineShort', { date: shortDate(version.payload.responseDeadline) })}</span>
      </p>
      {invitation.staleReason === 'rfq_amended' ? (
        <p className="banner banner--warning" role="status">
          {newest.version > invitation.rfqVersion.version ? t('commerce.sales.rfqChanged', { version: newest.version, old: invitation.rfqVersion.version }) : t('commerce.sales.rfqChangedUnknown', { old: invitation.rfqVersion.version })}{' '}
          {live.length === 0 ? t('commerce.sales.waitRevalidation') : null}
        </p>
      ) : null}
      {invitation.staleReason === 'rfq_closed' ? (
        <p className="banner banner--warning" role="status">
          {t('commerce.sales.rfqClosed')}
        </p>
      ) : null}
      <div className="ws-grid ws-grid--main">
        <div className="ws-section">
          <h2 className="ws-h2">{t('commerce.tabs.requirements')}</h2>
          {version.amendmentReason ? <p className="ws-muted">{t('commerce.rfq.amendmentReasonShown', { reason: version.amendmentReason })}</p> : null}
          <LinesTable lines={version.payload.lines} caption={t('commerce.lines.title')} />
          <RfqTerms payload={version.payload} />
        </div>
        <div className="ws-section">
          <section className="ws-card" aria-labelledby="respond-title">
            <h2 id="respond-title" className="ws-h2">
              {t('commerce.sales.respondTitle')}
            </h2>
            {quote ? (
              <NextLink href={href(`/app/sales/quotes/${encodeURIComponent(quote.id)}`)} className="ws-more">
                {t('commerce.sales.openQuote')}
              </NextLink>
            ) : null}
            {canQuote ? (
              <ConfirmCommand
                label={t('commerce.sales.prepare')}
                title={t('commerce.sales.prepareTitle')}
                body={t('commerce.sales.prepareBody', { version: version.version })}
                path="/v1/quotes"
                payload={{ rfqId: id, rfqVersionId: version.id, seller: invitation.party, payload: prefillQuotePayload(version.payload, null), privateConstraint: null, actor: { via: 'person' } }}
                demo={COMMERCE_DEMO}
                variant="accent"
                redirect={{ base: '/app/sales/quotes', key: 'quote.id' }}
              />
            ) : null}
            {invitation.status === 'sent' ? (
              <ConfirmCommand label={t('commerce.sales.markViewed')} title={t('commerce.sales.markViewedTitle')} body={t('commerce.sales.markViewedBody')} path={`/v1/rfq-invitations/${encodeURIComponent(invitation.id)}/respond`} payload={{ status: 'viewed' }} demo={COMMERCE_DEMO} />
            ) : null}
            {!quote && (invitation.status === 'sent' || invitation.status === 'viewed') && !invitation.staleReason ? (
              <ConfirmCommand label={t('commerce.sales.decline')} title={t('commerce.sales.declineTitle')} body={t('commerce.sales.declineBody')} path={`/v1/rfq-invitations/${encodeURIComponent(invitation.id)}/respond`} payload={{ status: 'declined' }} demo={COMMERCE_DEMO} variant="ghost" destructive />
            ) : null}
            <p className="ws-note">{t('commerce.sales.privacyNote')}</p>
          </section>
        </div>
      </div>
    </>
  );
}
