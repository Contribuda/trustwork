import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { Breadcrumb } from '@/components/ui';
import { PageHeader } from '@/components/workspace/parts';
import { commerce, COMMERCE_DEMO } from '@/components/commerce/data';
import type { SellerAgreementView, SellerQuoteView } from '@/components/commerce/contracts';
import { ConfirmCommand, QuoteDraftForm, ReasonCommand, SellerAcceptForm } from '@/components/commerce/commands';
import { partyLabels } from '@/components/commerce/labels';
import { prefillQuotePayload } from '@/components/commerce/quote-prefill';
import { money } from '@/components/commerce/format';
import { AgreementStatus, Digest, Facts, Obligations, OrderStatus, PrivateLabel, QuoteLinesTable, QuoteStatus, StaleChip, TabNav, type TabDef } from '@/components/commerce/parts';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { shortDate, t, tDynamic } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

type Params = { params: Promise<{ id: string }>; searchParams: PageSearchParams };
const TABS = ['editor', 'versions', 'negotiation', 'order'] as const;
type Tab = (typeof TABS)[number];
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  await primeLocale();
  const { id } = await params;
  const principal = await requirePrincipal(searchParams, `/app/sales/quotes/${id}`);
  const quote = await commerce.getQuote(principal, id);
  return { title: quote && quote.projection === 'owner_private' ? t('commerce.quote.title') : t('ws.notFoundTitle') };
}

type Label = (party: { kind: 'person' | 'company'; id: string }) => string;

/**
 * The seller's quote (journeys 2 and 4): the open draft in the editor, immutable sent versions, the buyer's structured
 * requests answered with new versions, and the order the buyer placed, accepted or declined as a separate event. The
 * seller's floors and notes are labelled private; the buyer's budget never reaches this page. The buyer side and anyone
 * else get 404.
 */
export default async function SalesQuotePage({ params, searchParams }: Params) {
  await primeLocale();
  const { id } = await params;
  const principal = await requirePrincipal(searchParams, `/app/sales/quotes/${id}`);
  const quote = await commerce.getQuote(principal, id);
  if (!quote || quote.projection !== 'owner_private') notFound();
  const [rfqView, agreementList] = await Promise.all([commerce.getRfq(principal, quote.quote.rfqId), commerce.listAgreements(principal)]);
  const rfq = rfqView?.projection === 'shared_party' ? rfqView : null;
  const agreements = (await Promise.all(agreementList.filter((a) => a.side === 'seller' && a.rfqId === quote.quote.rfqId).map((a) => commerce.getAgreement(principal, a.id)))).filter((a): a is SellerAgreementView => a?.side === 'seller' && a.quoteId === quote.quote.id);
  const sp = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(one(sp.tab) ?? '') ? (one(sp.tab) as Tab) : 'editor';
  const label = await partyLabels(principal, [quote.quote.buyer, quote.quote.seller]);
  const href = (path: string) => hrefFor(principal, path);
  const base = `/app/sales/quotes/${encodeURIComponent(id)}`;
  const draft = quote.versions.find((v) => v.status === 'draft') ?? null;
  const sent = [...quote.versions].reverse().find((v) => v.status !== 'draft') ?? null;
  const latest = draft ?? sent ?? quote.versions[0]!;
  const liveInvitation = rfq?.invitations.filter((i) => !i.staleReason && i.status !== 'withdrawn' && i.status !== 'declined').at(-1) ?? null;
  const currentRfqVersion = liveInvitation ? (rfq?.versions.find((v) => v.id === liveInvitation.rfqVersion.id) ?? null) : null;
  const pinned = rfq?.versions.find((v) => v.id === latest.rfqVersion.id) ?? null;
  const stale = quote.quote.staleReason === 'rfq_amended' || (currentRfqVersion !== null && latest.rfqVersion.id !== currentRfqVersion.id);
  const closed = ['accepted', 'withdrawn'].includes(quote.quote.status) || rfq?.rfq.status !== 'published';
  const canOpen = !draft && !closed && currentRfqVersion !== null;
  const openRequest = quote.amendmentRequests.find((r) => r.status === 'open') ?? null;
  const tabs: TabDef[] = [
    { id: 'editor', label: t('commerce.quoteTabs.editor') },
    { id: 'versions', label: t('commerce.quoteTabs.versions'), count: quote.versions.length },
    { id: 'negotiation', label: t('commerce.quoteTabs.negotiation'), count: quote.amendmentRequests.length },
    { id: 'order', label: t('commerce.quoteTabs.order') },
  ];
  const openPayload = (answers: string | null) =>
    currentRfqVersion
      ? { expectedRevision: quote.quote.revision, rfqVersionId: currentRfqVersion.id, payload: prefillQuotePayload(currentRfqVersion.payload, latest.payload), answersAmendmentRequestId: answers, actor: { via: 'person' } }
      : null;
  const title = pinned?.payload.title ?? currentRfqVersion?.payload.title ?? t('commerce.quote.title');
  return (
    <>
      <PageHeader title={title} lede={t('commerce.quote.lede', { buyer: label(quote.quote.buyer), seller: label(quote.quote.seller) })}>
        <Breadcrumb items={[{ id: 'sales', label: t('sales.title'), href: href('/app/sales') }, { id: 'quote', label: title }]} />
      </PageHeader>
      {COMMERCE_DEMO ? <p className="ws-note">{t('commerce.demoNote')}</p> : null}
      <p className="cm-actions" style={{ marginBottom: 16 }}>
        <QuoteStatus status={quote.quote.status} />
        <span>{draft ? t('commerce.versionDraft', { version: draft.version }) : sent ? t('commerce.versionN', { version: sent.version }) : null}</span>
        {stale ? <StaleChip version={latest.rfqVersion.version} /> : null}
        {sent?.validUntil ? <span className="ws-muted">{t('commerce.quote.validUntil', { date: shortDate(sent.validUntil) })}</span> : null}
        <NextLink href={href(`/app/sales/rfq/${encodeURIComponent(quote.quote.rfqId)}`)}>{t('commerce.quote.openRequest')}</NextLink>
      </p>
      {stale ? (
        <div className="banner banner--warning" role="status">
          <span>{currentRfqVersion && currentRfqVersion.version > latest.rfqVersion.version ? t('commerce.sales.rfqChanged', { version: currentRfqVersion.version, old: latest.rfqVersion.version }) : t('commerce.sales.rfqChangedUnknown', { old: latest.rfqVersion.version })}</span>
          {canOpen && currentRfqVersion && currentRfqVersion.id !== latest.rfqVersion.id ? (
            <ConfirmCommand label={t('commerce.quote.createForNew')} title={t('commerce.quote.createForNewTitle', { version: currentRfqVersion.version })} body={t('commerce.quote.createForNewBody')} path={`/v1/quotes/${encodeURIComponent(id)}/versions`} payload={openPayload(null)!} demo={COMMERCE_DEMO} variant="accent" />
          ) : !currentRfqVersion || currentRfqVersion.id === latest.rfqVersion.id ? (
            <span>{t('commerce.sales.waitRevalidation')}</span>
          ) : null}
        </div>
      ) : null}
      <TabNav tabs={tabs} current={tab} href={(x) => href(`${base}?tab=${x}`)} label={t('commerce.tabs.label')} />
      <h2 className="ws-h2" tabIndex={-1}>
        {tabs.find((x) => x.id === tab)!.label}
      </h2>
      {tab === 'editor' ? (
        draft && pinned ? (
          <QuoteDraftForm
            quoteId={id}
            versionId={draft.id}
            version={draft.version}
            revision={quote.quote.revision}
            privateRevision={quote.privateConstraint.revision}
            payload={draft.payload}
            rfqLines={pinned.payload.lines.map((l) => ({ lineId: l.lineId, description: l.description, alternativesAllowed: l.alternativesAllowed, quantity: l.quantity }))}
            floors={quote.privateConstraint.floorPrices}
            notes={quote.privateConstraint.negotiationNotes}
            demo={COMMERCE_DEMO}
          />
        ) : sent ? (
          <div className="cm-stack">
            <p className="ws-note">{t('commerce.quote.sentImmutable', { version: sent.version, date: sent.sentAt ? shortDate(sent.sentAt) : '—' })}</p>
            <QuoteLinesTable version={{ lines: sent.payload.lines, totals: sent.payload.totals }} caption={t('commerce.quote.linesOfOwn', { version: sent.version })} />
            <div className="cm-actions">
              {canOpen && !stale ? (
                <ConfirmCommand label={t('commerce.quote.newVersion')} title={t('commerce.quote.newVersionTitle')} body={t('commerce.quote.newVersionBody', { version: sent.version })} path={`/v1/quotes/${encodeURIComponent(id)}/versions`} payload={openPayload(null)!} demo={COMMERCE_DEMO} />
              ) : null}
              {quote.quote.status === 'sent' && agreements.every((a) => !['proposed', 'accepted_by_buyer', 'accepted_by_both'].includes(a.agreement.status)) ? (
                <ReasonCommand label={t('commerce.quote.withdraw')} title={t('commerce.quote.withdrawTitle')} body={t('commerce.quote.withdrawBody')} reasonLabel={t('commerce.reason')} path={`/v1/quotes/${encodeURIComponent(id)}/withdraw`} payload={{ expectedRevision: quote.quote.revision, actor: { via: 'person' } }} demo={COMMERCE_DEMO} destructive />
              ) : null}
            </div>
          </div>
        ) : (
          <p className="ws-muted">{t('commerce.quote.noVersion')}</p>
        )
      ) : null}
      {tab === 'versions' ? <Versions quote={quote} /> : null}
      {tab === 'negotiation' ? (
        <div className="cm-stack">
          <section className="ws-card ws-card--muted" aria-labelledby="seller-notes">
            <h3 id="seller-notes" className="ws-h2">
              {t('commerce.quote.notes')}
            </h3>
            <PrivateLabel />
            <p>{quote.privateConstraint.negotiationNotes || t('commerce.rfq.noNotes')}</p>
          </section>
          {quote.amendmentRequests.length === 0 ? (
            <div className="ws-empty">
              <strong>{t('commerce.negotiation.noRequests')}</strong>
            </div>
          ) : (
            <ul className="ws-list">
              {quote.amendmentRequests.map((r) => {
                const asked = quote.versions.find((v) => v.id === r.quoteVersionId);
                return (
                  <li key={r.id} className="ws-row">
                    <span className="ws-row__main">
                      <span className="ws-row__title">{t('commerce.negotiation.requestOnVersion', { version: asked?.version ?? '—', date: shortDate(r.createdAt) })}</span>
                      <span className="ws-row__meta">
                        <span>{tDynamic(`commerce.status.request.${r.status}`, r.status)}</span>
                        {r.targetTotal ? <span>{t('commerce.negotiation.askedTotal', { amount: money(r.targetTotal) })}</span> : null}
                        {r.answeredByVersion ? <span>{t('commerce.negotiation.answeredBy', { version: r.answeredByVersion })}</span> : null}
                      </span>
                      {r.changes.map((c) => {
                        const n = (asked?.payload.lines.findIndex((l) => l.lineId === c.lineId) ?? -1) + 1;
                        return (
                          <span key={c.lineId} className="cm-spec">
                            {t('commerce.lines.line', { n: n || '—' })}: {c.targetUnitPrice ? t('commerce.negotiation.askedPrice', { amount: money(c.targetUnitPrice) }) : null} {c.reason ?? ''}
                          </span>
                        );
                      })}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {openRequest && canOpen ? (
            <ConfirmCommand label={t('commerce.negotiation.answer')} title={t('commerce.negotiation.answerTitle')} body={t('commerce.negotiation.answerBody')} path={`/v1/quotes/${encodeURIComponent(id)}/versions`} payload={openPayload(openRequest.id)!} demo={COMMERCE_DEMO} variant="accent" />
          ) : null}
        </div>
      ) : null}
      {tab === 'order' ? <SellerOrders agreements={agreements} label={label} /> : null}
    </>
  );
}

function Versions({ quote }: { quote: SellerQuoteView }) {
  return (
    <div className="ws-table-wrap">
      <table className="ws-table">
        <caption>{t('commerce.quoteTabs.versions')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('procurement.col.version')}</th>
            <th scope="col">{t('procurement.col.status')}</th>
            <th scope="col">{t('commerce.col.sent')}</th>
            <th scope="col">{t('commerce.col.answers')}</th>
            <th scope="col">{t('commerce.order.digest')}</th>
            <th scope="col">{t('commerce.totals.gross')}</th>
          </tr>
        </thead>
        <tbody>
          {[...quote.versions].reverse().map((v) => (
            <tr key={v.id}>
              <td data-label={t('procurement.col.version')}>{t('commerce.versionN', { version: v.version })}</td>
              <td data-label={t('procurement.col.status')}>
                <QuoteStatus status={v.status} />
              </td>
              <td data-label={t('commerce.col.sent')}>{v.sentAt ? shortDate(v.sentAt) : t('commerce.quote.notSent')}</td>
              <td data-label={t('commerce.col.answers')}>
                {t('commerce.versionN', { version: v.rfqVersion.version })} {v.staleReason ? <StaleChip version={v.rfqVersion.version} /> : null}
              </td>
              <td data-label={t('commerce.order.digest')}>
                <Digest value={v.digest} />
              </td>
              <td data-label={t('commerce.totals.gross')}>{money(v.payload.totals.gross)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SellerOrders({ agreements, label }: { agreements: SellerAgreementView[]; label: Label }) {
  if (agreements.length === 0) {
    return (
      <div className="ws-empty">
        <strong>{t('commerce.sellerOrder.none')}</strong>
      </div>
    );
  }
  return (
    <div className="cm-stack">
      {agreements.map((a) => {
        const order = a.orders.find((o) => o.status !== 'cancelled') ?? a.orders.at(-1) ?? null;
        const accepted = a.events.find((e) => e.kind === 'seller_accepts_order');
        return (
          <section key={a.agreement.id} className="ws-card" aria-label={t('commerce.sellerOrder.selected', { version: a.agreement.acceptedTerms.quoteVersion.version })}>
            <h3 className="ws-h2">{t('commerce.sellerOrder.selected', { version: a.agreement.acceptedTerms.quoteVersion.version })}</h3>
            <p className="cm-actions">
              <AgreementStatus status={a.agreement.status} />
              {order ? <OrderStatus status={order.status} /> : null}
            </p>
            <Facts
              items={[
                [t('sales.col.buyer'), label(a.agreement.parties.buyer)],
                [t('commerce.accept.rfqVersion'), t('commerce.versionN', { version: a.agreement.acceptedTerms.rfqVersion.version })],
                [t('commerce.order.digest'), <Digest key="d" value={a.agreement.acceptedTerms.digest} />],
                [t('commerce.order.reference'), order?.externalReference ?? '—'],
              ]}
            />
            <p className="ws-note">{t('commerce.order.immutable')}</p>
            {a.agreement.status === 'accepted_by_buyer' && order?.status === 'placed' ? (
              <div className="cm-actions">
                <SellerAcceptForm agreementId={a.agreement.id} revision={a.agreement.revision} digest={a.agreement.acceptedTerms.digest} demo={COMMERCE_DEMO} />
                <ReasonCommand label={t('commerce.sellerOrder.decline')} title={t('commerce.sellerOrder.declineTitle')} body={t('commerce.sellerOrder.declineBody')} reasonLabel={t('commerce.sellerOrder.declineReason')} path={`/v1/agreements/${encodeURIComponent(a.agreement.id)}/decline`} payload={{ expectedRevision: a.agreement.revision, actor: { via: 'person' } }} demo={COMMERCE_DEMO} destructive />
              </div>
            ) : a.agreement.status === 'accepted_by_buyer' ? (
              <p className="ws-muted">{t('commerce.sellerOrder.awaitingOrder')}</p>
            ) : null}
            {accepted ? <p>{t('commerce.sellerOrder.acceptedOn', { date: shortDate(accepted.occurredAt) })}</p> : null}
            {a.agreement.obligations.length ? (
              <>
                <h4>{t('commerce.order.obligations')}</h4>
                <Obligations items={a.agreement.obligations} label={label} />
              </>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
