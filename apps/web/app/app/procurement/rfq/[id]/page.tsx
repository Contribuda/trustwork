import type { Metadata } from 'next';
import NextLink from '@/components/locale/LocalLink';
import { notFound, redirect } from 'next/navigation';
import { Breadcrumb, StatusChip } from '@/components/ui';
import { PageHeader } from '@/components/workspace/parts';
import { commerce, COMMERCE_DEMO } from '@/components/commerce/data';
import type { BuyerAgreementView, BuyerQuoteView, OwnerRfqView, QuoteComparison } from '@/components/commerce/contracts';
import { AcceptTermsForm, AmendmentForm, ConfirmCommand, InviteForm, PlaceOrderForm, PrivateForm, ReasonCommand, RfqDraftForm } from '@/components/commerce/commands';
import { ComparisonGrid, type GridCell, type GridOffer } from '@/components/commerce/comparison';
import { partyLabels } from '@/components/commerce/labels';
import { money, quantity } from '@/components/commerce/format';
import { AgreementStatus, Digest, Facts, InvitationStatus, LinesTable, Obligations, OrderStatus, PrivateLabel, QuoteLinesTable, QuoteStatus, RfqStatus, RfqTerms, StaleChip, TabNav, type TabDef } from '@/components/commerce/parts';
import { hrefFor, requirePrincipal, type PageSearchParams } from '@/app/_lib/principal';
import { shortDate, t, tDynamic } from '@/app/_lib/i18n';
import { primeLocale } from '@/app/_lib/locale';

type Params = { params: Promise<{ id: string }>; searchParams: PageSearchParams };
const TABS = ['requirements', 'suppliers', 'quotes', 'compare', 'negotiation', 'order', 'approvals'] as const;
type Tab = (typeof TABS)[number];

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  await primeLocale();
  const { id } = await params;
  const principal = await requirePrincipal(searchParams, `/app/procurement/rfq/${id}`);
  const view = await commerce.getRfq(principal, id);
  return { title: view && view.projection === 'owner_private' ? (view.versions.at(-1) ?? view.versions[0])?.payload.title : t('ws.notFoundTitle') };
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/**
 * One RFQ on the buyer side (journeys 3 and 4): immutable published versions and the open draft, invitations pinned
 * to exact versions, quotes, the honest comparison (stale versions are not comparable), structured negotiation, the
 * acceptance of exact terms and the order with authority and a transaction-budget reservation. Only the buyer side
 * sees this page (an invited supplier is sent to its sales view; anyone else gets 404). The budget ceiling and notes
 * are the buyer-private record and are labelled so.
 */
export default async function RfqPage({ params, searchParams }: Params) {
  await primeLocale();
  const { id } = await params;
  const principal = await requirePrincipal(searchParams, `/app/procurement/rfq/${id}`);
  const view = await commerce.getRfq(principal, id);
  if (!view) notFound();
  if (view.projection !== 'owner_private') redirect(hrefFor(principal, `/app/sales/rfq/${encodeURIComponent(id)}`));
  const sp = await searchParams;
  const tab: Tab = (TABS as readonly string[]).includes(one(sp.tab) ?? '') ? (one(sp.tab) as Tab) : 'requirements';
  const { rfq } = view;
  const current = view.versions.find((v) => v.id === rfq.currentVersionId) ?? null;
  const draft = view.versions.find((v) => v.status === 'draft') ?? null;
  const latest = draft ?? current ?? view.versions[0]!;
  const published = rfq.status === 'published' && current !== null;
  const [comparison, historical, agreementsList] = await Promise.all([
    current ? commerce.getComparison(principal, id, 'current') : Promise.resolve(null),
    current ? commerce.getComparison(principal, id, 'historical') : Promise.resolve(null),
    commerce.listAgreements(principal),
  ]);
  const quoteIds = [...new Set([...(comparison?.entries.map((e) => e.quoteId) ?? []), ...(historical?.historical.map((h) => h.quoteId) ?? []), ...(comparison?.historical.map((h) => h.quoteId) ?? [])])];
  const quoteViews = new Map((await Promise.all(quoteIds.map(async (q) => [q, await commerce.getQuote(principal, q)] as const))).filter((e): e is readonly [string, BuyerQuoteView] => e[1]?.projection === 'shared_party'));
  const agreements = (await Promise.all(agreementsList.filter((a) => a.rfqId === id && a.side === 'buyer').map((a) => commerce.getAgreement(principal, a.id)))).filter((a): a is BuyerAgreementView => a?.side === 'buyer');
  const label = await partyLabels(principal, [rfq.owner, ...view.invitations.map((i) => i.party), ...[...quoteViews.values()].map((q) => q.quote.seller), ...agreements.map((a) => a.agreement.parties.seller)]);
  const href = (path: string) => hrefFor(principal, path);
  const base = `/app/procurement/rfq/${encodeURIComponent(id)}`;
  const tabHref = (t2: string, extra = '') => href(`${base}?tab=${t2}${extra}`);
  const liveAgreement = agreements.find((a) => ['proposed', 'accepted_by_buyer', 'accepted_by_both'].includes(a.agreement.status)) ?? null;

  const tabs: TabDef[] = [
    { id: 'requirements', label: t('commerce.tabs.requirements') },
    { id: 'suppliers', label: t('commerce.tabs.suppliers'), count: view.invitations.length },
    { id: 'quotes', label: t('commerce.tabs.quotes'), count: quoteViews.size },
    { id: 'compare', label: t('commerce.tabs.compare') },
    { id: 'negotiation', label: t('commerce.tabs.negotiation') },
    { id: 'order', label: t('commerce.tabs.order') },
    { id: 'approvals', label: t('commerce.tabs.approvals') },
  ];

  return (
    <>
      <PageHeader
        title={latest.payload.title}
        lede={rfq.owner.kind === 'company' ? t('commerce.rfq.ledeCompany', { name: label(rfq.owner) }) : t('commerce.rfq.ledePerson')}
        actions={
          <>
            {draft ? (
              <ConfirmCommand
                label={t('commerce.rfq.publish', { version: draft.version })}
                title={t('commerce.rfq.publishTitle', { version: draft.version })}
                body={draft.version > 1 ? t('commerce.rfq.publishAmendmentBody') : t('commerce.rfq.publishBody')}
                path={`/v1/rfqs/${encodeURIComponent(id)}/publish`}
                payload={{ rfqId: id, version: draft.version, expectedRevision: rfq.revision, amendmentReason: draft.amendmentReason, actor: { via: 'person' } }}
                demo={COMMERCE_DEMO}
                variant="accent"
                success={t('commerce.rfq.published', { version: draft.version })}
              />
            ) : null}
            {published && !draft ? (
              <ReasonCommand
                label={t('commerce.rfq.amend')}
                title={t('commerce.rfq.amendTitle')}
                body={t('commerce.rfq.amendNote')}
                reasonLabel={t('commerce.rfq.amendReason')}
                field="amendmentReason"
                path={`/v1/rfqs/${encodeURIComponent(id)}/versions`}
                payload={{ expectedRevision: rfq.revision, actor: { via: 'person' } }}
                demo={COMMERCE_DEMO}
              />
            ) : null}
            {published ? (
              <ReasonCommand
                label={t('commerce.rfq.close')}
                title={t('commerce.rfq.closeTitle')}
                body={t('commerce.rfq.closeBody')}
                reasonLabel={t('commerce.reason')}
                path={`/v1/rfqs/${encodeURIComponent(id)}/close`}
                payload={{ expectedRevision: rfq.revision, outcome: 'closed' }}
                demo={COMMERCE_DEMO}
                destructive
              />
            ) : null}
          </>
        }
      >
        <Breadcrumb items={[{ id: 'procurement', label: t('procurement.title'), href: href('/app/procurement') }, { id: 'rfq', label: latest.payload.title }]} />
      </PageHeader>
      <p className="cm-actions" style={{ marginBottom: 16 }}>
        <RfqStatus status={rfq.status} />
        {current ? <StatusChip tone="success" size="sm">{t('commerce.versionCurrent', { version: current.version })}</StatusChip> : null}
        {draft ? <StatusChip size="sm">{t('commerce.versionDraft', { version: draft.version })}</StatusChip> : null}
        <span className="ws-muted">{t('commerce.rfq.deadlineShort', { date: shortDate(latest.payload.responseDeadline) })}</span>
        {rfq.projectId ? <NextLink href={href(`/app/projects/${encodeURIComponent(rfq.projectId)}`)}>{t('commerce.rfq.project')}</NextLink> : null}
      </p>
      {COMMERCE_DEMO ? <p className="ws-note">{t('commerce.demoNote')}</p> : null}
      <TabNav tabs={tabs} current={tab} href={(x) => tabHref(x)} label={t('commerce.tabs.label')} />
      <div className="ws-grid ws-grid--main">
        <div className="ws-section">
          <h2 className="ws-h2" id="tab-title" tabIndex={-1}>
            {tabs.find((x) => x.id === tab)!.label}
          </h2>
          {tab === 'requirements' ? <Requirements view={view} selected={one(sp.v)} tabHref={tabHref} /> : null}
          {tab === 'suppliers' ? <Suppliers view={view} principal={principal} label={label} published={published} /> : null}
          {tab === 'quotes' ? <Quotes view={view} quotes={[...quoteViews.values()]} label={label} tabHref={tabHref} /> : null}
          {tab === 'compare' ? <Compare view={view} comparison={comparison} quotes={quoteViews} label={label} liveAgreement={liveAgreement !== null} orderHref={tabHref('order')} includeStale={one(sp.stale) === '1'} staleHref={tabHref('compare', one(sp.stale) === '1' ? '' : '&stale=1')} /> : null}
          {tab === 'negotiation' ? <Negotiation view={view} quotes={[...quoteViews.values()]} selected={one(sp.quote)} label={label} tabHref={tabHref} /> : null}
          {tab === 'order' ? <Orders view={view} agreements={agreements} label={label} compareHref={tabHref('compare')} /> : null}
          {tab === 'approvals' ? <Approvals agreements={agreements} label={label} /> : null}
        </div>
        <aside className="ws-section" aria-label={t('commerce.rfq.rail')}>
          <section className="ws-card" aria-labelledby="private-title">
            <h2 id="private-title" className="ws-h2">
              {t('commerce.rfq.budgetCeiling')}
            </h2>
            <PrivateLabel />
            <p className="ws-muted">{view.privateConstraint.budgetCeiling ? money(view.privateConstraint.budgetCeiling) : t('commerce.rfq.noCeiling')}</p>
            <PrivateForm rfqId={id} revision={view.privateConstraint.revision} currency={latest.payload.currency} ceiling={view.privateConstraint.budgetCeiling} notes={view.privateConstraint.internalNotes} demo={COMMERCE_DEMO} />
          </section>
          <section className="ws-card" aria-labelledby="summary-title">
            <h2 id="summary-title" className="ws-h2">
              {t('commerce.rfq.summary')}
            </h2>
            <Facts
              items={[
                [t('commerce.list.invitations'), String(view.invitations.length)],
                [t('commerce.rfq.staleInvitations'), String(view.invitations.filter((i) => i.staleReason).length)],
                [t('commerce.tabs.quotes'), String(quoteViews.size)],
                [t('commerce.rfq.agreement'), liveAgreement ? tDynamic(`commerce.status.agreement.${liveAgreement.agreement.status}`, liveAgreement.agreement.status) : '—'],
              ]}
            />
          </section>
        </aside>
      </div>
    </>
  );
}

type Label = (party: { kind: 'person' | 'company'; id: string }) => string;
type TabHref = (tab: string, extra?: string) => string;

function Requirements({ view, selected, tabHref }: { view: OwnerRfqView; selected: string | undefined; tabHref: TabHref }) {
  const draft = view.versions.find((v) => v.status === 'draft') ?? null;
  const fallback = draft ?? view.versions.find((v) => v.id === view.rfq.currentVersionId) ?? view.versions.at(-1)!;
  const version = view.versions.find((v) => v.id === selected) ?? fallback;
  return (
    <div className="cm-stack">
      <nav aria-label={t('commerce.rfq.versions')}>
        <ul className="cm-actions" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {view.versions.map((v) => (
            <li key={v.id}>
              <NextLink href={tabHref('requirements', `&v=${encodeURIComponent(v.id)}`)} aria-current={v.id === version.id ? 'page' : undefined} className={`ws-chip${v.id === version.id ? ' ws-chip--on' : ''}`}>
                {v.status === 'draft' ? t('commerce.versionDraft', { version: v.version }) : v.id === view.rfq.currentVersionId ? t('commerce.versionCurrent', { version: v.version }) : t('commerce.versionSuperseded', { version: v.version })}
              </NextLink>
            </li>
          ))}
        </ul>
      </nav>
      {version.status === 'draft' ? (
        <>
          <p className="ws-note">{version.version > 1 ? t('commerce.rfq.draftAmendment', { reason: version.amendmentReason ?? '' }) : t('commerce.rfq.draftFirst')}</p>
          <RfqDraftForm rfqId={view.rfq.id} versionId={version.id} revision={view.rfq.revision} payload={version.payload} demo={COMMERCE_DEMO} />
        </>
      ) : (
        <>
          <p className="ws-note">
            {t('commerce.rfq.immutable', { date: version.publishedAt ? shortDate(version.publishedAt) : '—' })} <Digest value={version.digest} />
          </p>
          {version.amendmentReason ? <p className="ws-muted">{t('commerce.rfq.amendmentReasonShown', { reason: version.amendmentReason })}</p> : null}
          <LinesTable lines={version.payload.lines} caption={t('commerce.lines.title')} />
          <RfqTerms payload={version.payload} />
        </>
      )}
    </div>
  );
}

function Suppliers({ view, principal, label, published }: { view: OwnerRfqView; principal: Parameters<typeof commerce.supplierCandidates>[0]; label: Label; published: boolean }) {
  const current = view.rfq.currentVersionId;
  return (
    <div className="cm-stack">
      {view.invitations.length === 0 ? (
        <div className="ws-empty">
          <strong>{t('commerce.invite.none')}</strong>
        </div>
      ) : (
        <div className="ws-table-wrap">
          <table className="ws-table">
            <caption>{t('commerce.tabs.suppliers')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('commerce.col.supplier')}</th>
                <th scope="col">{t('commerce.col.pinned')}</th>
                <th scope="col">{t('procurement.col.status')}</th>
                <th scope="col">{t('commerce.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {view.invitations.map((inv) => {
                const revalidated = view.invitations.some((o) => o.id !== inv.id && o.party.kind === inv.party.kind && o.party.id === inv.party.id && o.rfqVersion.id === current);
                const active = inv.status !== 'declined' && inv.status !== 'withdrawn';
                return (
                  <tr key={inv.id}>
                    <td data-label={t('commerce.col.supplier')}>{label(inv.party)}</td>
                    <td data-label={t('commerce.col.pinned')}>
                      {t('commerce.versionN', { version: inv.rfqVersion.version })} {inv.staleReason ? <StaleChip version={inv.rfqVersion.version} /> : null}
                    </td>
                    <td data-label={t('procurement.col.status')}>
                      <InvitationStatus status={inv.status} />
                    </td>
                    <td data-label={t('commerce.col.actions')}>
                      <span className="cm-actions">
                        {inv.staleReason === 'rfq_amended' && active && !revalidated && published ? (
                          <ConfirmCommand label={t('commerce.invite.revalidate')} title={t('commerce.invite.revalidateTitle', { name: label(inv.party) })} body={t('commerce.invite.revalidateBody')} path={`/v1/rfqs/${encodeURIComponent(view.rfq.id)}/invitations/${encodeURIComponent(inv.id)}/revalidate`} payload={{ actor: { via: 'person' } }} demo={COMMERCE_DEMO} />
                        ) : null}
                        {active && !inv.staleReason ? (
                          <ReasonCommand label={t('commerce.invite.withdraw')} title={t('commerce.invite.withdrawTitle', { name: label(inv.party) })} body={t('commerce.invite.withdrawBody')} reasonLabel={t('commerce.reason')} path={`/v1/rfqs/${encodeURIComponent(view.rfq.id)}/invitations/${encodeURIComponent(inv.id)}/withdraw`} payload={{}} demo={COMMERCE_DEMO} />
                        ) : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {published && current ? <InviteSection view={view} principal={principal} current={current} /> : <p className="ws-note">{t('commerce.invite.publishFirst')}</p>}
    </div>
  );
}

async function InviteSection({ view, principal, current }: { view: OwnerRfqView; principal: Parameters<typeof commerce.supplierCandidates>[0]; current: string }) {
  const candidates = (await commerce.supplierCandidates(principal)).filter((c) => !(c.party.kind === view.rfq.owner.kind && c.party.id === view.rfq.owner.id));
  const invited = new Set(view.invitations.filter((i) => i.rfqVersion.id === current && i.status !== 'withdrawn').map((i) => `${i.party.kind}:${i.party.id}`));
  return (
    <section className="ws-card" aria-labelledby="invite-title">
      <h3 id="invite-title" className="ws-h2">
        {t('commerce.invite.title')}
      </h3>
      <p className="ws-muted">{t('commerce.invite.body')}</p>
      <InviteForm
        rfqId={view.rfq.id}
        rfqVersionId={current}
        candidates={candidates.map((c) => {
          const isInvited = invited.has(`${c.party.kind}:${c.party.id}`);
          const kind = c.party.kind === 'company' ? t('commerce.party.company') : t('commerce.party.person');
          const note = isInvited ? ` · ${t('commerce.invite.alreadyInvited')}` : !c.outreach ? ` · ${t('commerce.invite.outreachShort')}` : '';
          return { value: `${c.party.kind}:${c.party.id}`, label: `${c.label} · ${kind}${note}`, disabled: isInvited || !c.outreach };
        })}
        demo={COMMERCE_DEMO}
      />
    </section>
  );
}

function Quotes({ view, quotes, label, tabHref }: { view: OwnerRfqView; quotes: BuyerQuoteView[]; label: Label; tabHref: TabHref }) {
  if (quotes.length === 0) {
    return (
      <div className="ws-empty">
        <strong>{t('commerce.quotes.empty', { count: view.invitations.filter((i) => !i.staleReason).length })}</strong>
      </div>
    );
  }
  return (
    <div className="ws-table-wrap">
      <table className="ws-table">
        <caption>{t('commerce.tabs.quotes')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('commerce.col.supplier')}</th>
            <th scope="col">{t('procurement.col.version')}</th>
            <th scope="col">{t('procurement.col.status')}</th>
            <th scope="col">{t('commerce.col.answers')}</th>
            <th scope="col">{t('commerce.col.validUntil')}</th>
            <th scope="col">{t('commerce.totals.gross')}</th>
          </tr>
        </thead>
        <tbody>
          {quotes.flatMap((q) =>
            [...q.versions].reverse().map((v) => (
              <tr key={v.id}>
                <td data-label={t('commerce.col.supplier')}>
                  <NextLink href={tabHref('negotiation', `&quote=${encodeURIComponent(q.quote.id)}`)}>{label(q.quote.seller)}</NextLink>
                </td>
                <td data-label={t('procurement.col.version')}>{t('commerce.versionN', { version: v.version })}</td>
                <td data-label={t('procurement.col.status')}>
                  <QuoteStatus status={v.status} />
                </td>
                <td data-label={t('commerce.col.answers')}>
                  {t('commerce.versionN', { version: v.rfqVersion.version })} {v.staleReason || v.rfqVersion.id !== view.rfq.currentVersionId ? <StaleChip version={v.rfqVersion.version} /> : null}
                </td>
                <td data-label={t('commerce.col.validUntil')}>{shortDate(v.validUntil)}</td>
                <td data-label={t('commerce.totals.gross')}>{money(v.totals.gross)}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

function cellFor(line: QuoteComparison['entries'][number]['lines'][number]): GridCell {
  const price = `${money(line.unitPrice)} × ${quantity(line.offered)} = ${money(line.lineTotal)}`;
  switch (line.match) {
    case 'matched':
      return { kind: 'comparable', value: price };
    case 'quantity_differs':
      return { kind: 'nonComparable', value: price, reason: 'scope', detail: t('commerce.compare.quantityDiffers', { requested: quantity(line.requested), offered: quantity(line.offered) }) };
    case 'unit_differs':
      return { kind: 'nonComparable', value: price, reason: 'unit', detail: t('commerce.compare.quantityDiffers', { requested: quantity(line.requested), offered: quantity(line.offered) }) };
    case 'substitution':
      return { kind: 'nonComparable', value: price, reason: 'substitution' };
    default:
      return { kind: 'nonComparable', reason: 'missingLine' };
  }
}

function Compare({ view, comparison, quotes, label, liveAgreement, orderHref, includeStale, staleHref }: { view: OwnerRfqView; comparison: QuoteComparison | null; quotes: Map<string, BuyerQuoteView>; label: Label; liveAgreement: boolean; orderHref: string; includeStale: boolean; staleHref: string }) {
  const current = view.versions.find((v) => v.id === view.rfq.currentVersionId);
  if (!comparison || !current || !current.digest) return <p className="ws-note">{t('commerce.invite.publishFirst')}</p>;
  const rfqRef = { id: current.id, version: current.version, digest: current.digest };
  const lines = current.payload.lines.map((l, i) => ({ id: l.lineId, label: `${i + 1}. ${l.description}`, detail: quantity(l.quantity) }));
  const cells: Record<string, Record<string, GridCell>> = Object.fromEntries(lines.map((l) => [l.id, {}]));
  const selectable = comparison.entries.filter((e) => !liveAgreement && !e.notTotalledBecause.includes('expired') && quotes.has(e.quoteId));
  const offers: GridOffer[] = comparison.entries.map((e) => {
    for (const line of e.lines) (cells[line.rfqLineId] ??= {})[e.quoteId] = cellFor(line);
    const canSelect = selectable.includes(e);
    return { id: e.quoteId, supplier: label(e.seller), version: String(e.version.version), stale: false, note: null, total: e.comparableTotal ? money(e.comparableTotal.gross) : null, anchor: canSelect ? `accept-${e.quoteId}` : null };
  });
  const stale = comparison.historical.filter((h) => h.staleReason);
  if (includeStale) {
    for (const h of stale) {
      const id = `stale-${h.version.id}`;
      const note = t('commerce.stale', { version: h.rfqVersion.version });
      for (const l of lines) (cells[l.id] ??= {})[id] = { kind: 'nonComparable', reason: 'scope', detail: note };
      offers.push({ id, supplier: label(h.seller), version: String(h.version.version), stale: true, note, total: null, anchor: null });
    }
  }
  return (
    <div className="cm-stack">
      <p className="ws-muted">{t('commerce.compare.lede', { version: current.version })}</p>
      {stale.length ? (
        <p>
          <NextLink href={staleHref} className="ws-chip">
            {includeStale ? t('commerce.compare.hideStale') : t('commerce.compare.includeStale', { count: stale.length })}
          </NextLink>
        </p>
      ) : null}
      {offers.length === 0 ? (
        <div className="ws-empty">
          <strong>{t('commerce.compare.empty')}</strong>
        </div>
      ) : (
        <ComparisonGrid caption={t('commerce.compare.caption', { version: current.version })} lines={lines} offers={offers} cells={cells} />
      )}
      {comparison.entries.map((e) => (
        <section key={e.quoteId} className="ws-card" aria-label={t('commerce.compare.detailsOf', { supplier: label(e.seller) })}>
          <h3 className="ws-h2">{label(e.seller)}</h3>
          <p>{e.comparableTotal ? t('commerce.compare.total', { amount: money(e.comparableTotal.gross) }) : t('commerce.compare.notTotalled', { reasons: e.notTotalledBecause.map((r) => tDynamic(`commerce.compare.reason.${r}`, r)).join(', ') })}</p>
          {e.exclusions.length ? (
            <>
              <h4>{t('commerce.compare.exclusions')}</h4>
              <ul className="cm-checklist">
                {e.exclusions.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </>
          ) : null}
          {e.extras.length ? <p className="ws-note--warn">{t('commerce.compare.extras', { count: e.extras.length })}</p> : null}
          {liveAgreement ? <p className="ws-muted">{t('commerce.compare.agreementExists')}</p> : e.notTotalledBecause.includes('expired') ? <p className="ws-muted">{t('commerce.compare.expired')}</p> : null}
          {selectable.includes(e) ? (
            <div id={`accept-${e.quoteId}`} className="cm-stack">
              <AcceptTermsForm rfqId={view.rfq.id} quoteRef={e.version} rfqRef={rfqRef} quoteRevision={quotes.get(e.quoteId)!.quote.revision} supplier={label(e.seller)} gross={e.comparableTotal ? money(e.comparableTotal.gross) : null} demo={COMMERCE_DEMO} orderHref={orderHref} />
            </div>
          ) : null}
        </section>
      ))}
      {comparison.historical.length ? (
        <section className="ws-card" aria-labelledby="historical-title">
          <h3 id="historical-title" className="ws-h2">
            {t('commerce.compare.historicalTitle')}
          </h3>
          <p className="ws-muted">{t('commerce.compare.historicalBody')}</p>
          <ul className="ws-list">
            {comparison.historical.map((h) => (
              <li key={h.version.id} className="ws-row">
                <span className="ws-row__main">
                  <span className="ws-row__title">
                    {label(h.seller)} · {t('commerce.versionN', { version: h.version.version })}
                  </span>
                  <span className="ws-row__meta">
                    <QuoteStatus status={h.status} />
                    {h.staleReason ? <StaleChip version={h.rfqVersion.version} /> : null}
                    <span>{t('compare.notComparable')}</span>
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Negotiation({ view, quotes, selected, label, tabHref }: { view: OwnerRfqView; quotes: BuyerQuoteView[]; selected: string | undefined; label: Label; tabHref: TabHref }) {
  const quote = quotes.find((q) => q.quote.id === selected) ?? quotes[0] ?? null;
  return (
    <div className="cm-stack">
      <section className="ws-card ws-card--muted" aria-labelledby="notes-title">
        <h3 id="notes-title" className="ws-h2">
          {t('commerce.rfq.internalNotes')}
        </h3>
        <PrivateLabel />
        <p>{view.privateConstraint.internalNotes || t('commerce.rfq.noNotes')}</p>
      </section>
      {quotes.length === 0 || !quote ? (
        <div className="ws-empty">
          <strong>{t('commerce.negotiation.empty')}</strong>
        </div>
      ) : (
        <>
          <nav aria-label={t('commerce.negotiation.choose')}>
            <ul className="cm-actions" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {quotes.map((q) => (
                <li key={q.quote.id}>
                  <NextLink href={tabHref('negotiation', `&quote=${encodeURIComponent(q.quote.id)}`)} aria-current={q.quote.id === quote.quote.id ? 'page' : undefined} className={`ws-chip${q.quote.id === quote.quote.id ? ' ws-chip--on' : ''}`}>
                    {label(q.quote.seller)}
                  </NextLink>
                </li>
              ))}
            </ul>
          </nav>
          <BuyerQuote view={view} quote={quote} label={label} />
        </>
      )}
    </div>
  );
}

function BuyerQuote({ view, quote, label }: { view: OwnerRfqView; quote: BuyerQuoteView; label: Label }) {
  const latest = quote.versions.at(-1) ?? null;
  const stale = latest ? latest.rfqVersion.id !== view.rfq.currentVersionId : false;
  const rfqVersion = view.versions.find((v) => v.id === latest?.rfqVersion.id);
  return (
    <div className="cm-stack">
      <p className="cm-actions">
        <QuoteStatus status={quote.quote.status} />
        {latest ? <span>{t('commerce.versionN', { version: latest.version })}</span> : null}
        {stale && latest ? <StaleChip version={latest.rfqVersion.version} /> : null}
        {latest ? <Digest value={latest.digest} /> : null}
      </p>
      {latest ? (
        <>
          <QuoteLinesTable version={latest} caption={t('commerce.quote.linesOf', { supplier: label(quote.quote.seller), version: latest.version })} />
          <Facts
            items={[
              [t('commerce.col.validUntil'), shortDate(latest.validUntil)],
              [t('commerce.quote.paymentTerms'), latest.paymentTerms || '—'],
              [t('commerce.quote.milestones'), latest.deliveryTerms.milestones.map((m) => `${m.description} (${shortDate(m.due.date)})`).join('; ') || '—'],
              [t('commerce.compare.exclusions'), latest.exclusions.join('; ') || '—'],
            ]}
          />
        </>
      ) : null}
      <h3 className="ws-h2">{t('commerce.negotiation.requests')}</h3>
      {quote.amendmentRequests.length === 0 ? (
        <p className="ws-muted">{t('commerce.negotiation.noRequests')}</p>
      ) : (
        <ul className="ws-list">
          {quote.amendmentRequests.map((r) => (
            <li key={r.id} className="ws-row">
              <span className="ws-row__main">
                <span className="ws-row__title">{t('commerce.negotiation.requestOn', { date: shortDate(r.createdAt) })}</span>
                <span className="ws-row__meta">
                  <span>{tDynamic(`commerce.status.request.${r.status}`, r.status)}</span>
                  {r.answeredByVersion ? <span>{t('commerce.negotiation.answeredBy', { version: r.answeredByVersion })}</span> : null}
                </span>
                {r.changes.map((c) => (
                  <span key={c.lineId} className="cm-spec">
                    {c.targetUnitPrice ? t('commerce.negotiation.askedPrice', { amount: money(c.targetUnitPrice) }) : null} {c.reason ?? ''}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
      {latest && latest.status === 'sent' && !stale && quote.quote.status === 'sent' && rfqVersion ? (
        <section className="ws-card" aria-labelledby="ask-title">
          <h3 id="ask-title" className="ws-h2">
            {t('commerce.negotiation.requestTitle')}
          </h3>
          <p className="ws-muted">{t('commerce.negotiation.requestBody')}</p>
          <AmendmentForm quoteId={quote.quote.id} versionId={latest.id} currency={latest.totals.gross.currency} lines={latest.lines.map((l, i) => ({ lineId: l.lineId, label: `${i + 1}. ${rfqVersion.payload.lines.find((x) => x.lineId === (l.rfqLineId ?? l.substitution?.forRfqLineId))?.description ?? t('commerce.quote.extraLine')}` }))} demo={COMMERCE_DEMO} />
        </section>
      ) : null}
    </div>
  );
}

function Orders({ view, agreements, label, compareHref }: { view: OwnerRfqView; agreements: BuyerAgreementView[]; label: Label; compareHref: string }) {
  if (agreements.length === 0) {
    return (
      <div className="ws-empty">
        <strong>{t('commerce.order.none')}</strong>
        <NextLink href={compareHref} className="ws-more">
          {t('commerce.tabs.compare')}
        </NextLink>
      </div>
    );
  }
  return (
    <div className="cm-stack">
      {agreements.map((a) => {
        const accepted = a.events.find((e) => e.kind === 'buyer_accepts_terms');
        const sellerAccepted = a.events.find((e) => e.kind === 'seller_accepts_order');
        const order = a.orders.find((o) => o.status !== 'cancelled') ?? a.orders.at(-1) ?? null;
        const live = a.agreement.status === 'accepted_by_buyer' || a.agreement.status === 'proposed';
        return (
          <section key={a.agreement.id} className="cm-stack" aria-label={t('commerce.order.snapshotOf', { supplier: label(a.agreement.parties.seller) })}>
            <div className="ws-card">
              <h3 className="ws-h2">{t('commerce.order.snapshot', { date: accepted ? shortDate(accepted.occurredAt) : '—', version: a.agreement.acceptedTerms.quoteVersion.version })}</h3>
              <p className="cm-actions">
                <AgreementStatus status={a.agreement.status} />
                {order ? <OrderStatus status={order.status} /> : null}
              </p>
              <Facts
                items={[
                  [t('commerce.col.supplier'), label(a.agreement.parties.seller)],
                  [t('commerce.accept.quoteVersion'), t('commerce.versionN', { version: a.agreement.acceptedTerms.quoteVersion.version })],
                  [t('commerce.accept.rfqVersion'), t('commerce.versionN', { version: a.agreement.acceptedTerms.rfqVersion.version })],
                  [t('commerce.order.digest'), <Digest key="d" value={a.agreement.acceptedTerms.digest} />],
                ]}
              />
              <p className="ws-note">{t('commerce.order.immutable')}</p>
            </div>
            <div className="ws-card">
              <h3 className="ws-h2">{t('commerce.order.authority')}</h3>
              <Facts
                items={[
                  [t('commerce.order.actsFor'), label(view.rfq.owner)],
                  [t('commerce.order.authoritySource'), view.rfq.owner.kind === 'company' ? t('commerce.order.authorityCompany') : t('commerce.order.authorityPerson')],
                  [t('commerce.order.assistant'), t('commerce.order.noMandate')],
                ]}
              />
            </div>
            <div className="ws-card">
              <h3 className="ws-h2">{t('commerce.order.budgetTitle')}</h3>
              <PrivateLabel />
              {order ? (
                <>
                  <p>{order.reservationId ? t('commerce.order.budgetReserved') : t('commerce.order.noReservation')}</p>
                  <p>{sellerAccepted ? t('commerce.order.sellerAccepted', { date: shortDate(sellerAccepted.occurredAt) }) : order.status === 'cancelled' ? t('commerce.order.cancelled') : t('commerce.order.awaitingSeller')}</p>
                </>
              ) : live ? (
                <PlaceOrderForm agreementId={a.agreement.id} rfqId={a.rfqId} quoteVersion={a.agreement.acceptedTerms.quoteVersion} rfqVersion={a.agreement.acceptedTerms.rfqVersion} revision={a.agreement.revision} demo={COMMERCE_DEMO} />
              ) : (
                <p className="ws-muted">{t('commerce.order.notAvailable')}</p>
              )}
            </div>
            {a.agreement.obligations.length ? (
              <div className="ws-card">
                <h3 className="ws-h2">{t('commerce.order.obligations')}</h3>
                <Obligations items={a.agreement.obligations} label={label} />
              </div>
            ) : null}
            {live ? (
              <div className="cm-actions">
                {order && order.status === 'placed' ? (
                  <ReasonCommand label={t('commerce.order.cancel')} title={t('commerce.order.cancelTitle')} body={t('commerce.order.cancelBody')} reasonLabel={t('commerce.reason')} path={`/v1/orders/${encodeURIComponent(order.id)}/cancel`} payload={{ expectedRevision: order.revision, actor: { via: 'person' } }} demo={COMMERCE_DEMO} destructive />
                ) : (
                  <ReasonCommand label={t('commerce.order.withdraw')} title={t('commerce.order.withdrawTitle')} body={t('commerce.order.withdrawBody')} reasonLabel={t('commerce.reason')} path={`/v1/agreements/${encodeURIComponent(a.agreement.id)}/withdraw`} payload={{ expectedRevision: a.agreement.revision, actor: { via: 'person' } }} demo={COMMERCE_DEMO} destructive />
                )}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function Approvals({ agreements, label }: { agreements: BuyerAgreementView[]; label: Label }) {
  const events = agreements.flatMap((a) => a.events);
  return (
    <div className="cm-stack">
      <p className="ws-note">{t('commerce.approvals.note')}</p>
      {events.length === 0 ? (
        <div className="ws-empty">
          <strong>{t('commerce.approvals.empty')}</strong>
        </div>
      ) : (
        <div className="ws-table-wrap">
          <table className="ws-table">
            <caption>{t('commerce.tabs.approvals')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('commerce.approvals.event')}</th>
                <th scope="col">{t('commerce.approvals.onBehalf')}</th>
                <th scope="col">{t('commerce.order.digest')}</th>
                <th scope="col">{t('commerce.approvals.records')}</th>
                <th scope="col">{t('commerce.approvals.when')}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td data-label={t('commerce.approvals.event')}>{tDynamic(`commerce.event.${e.kind}`, e.kind)}</td>
                  <td data-label={t('commerce.approvals.onBehalf')}>{label(e.onBehalfOf)}</td>
                  <td data-label={t('commerce.order.digest')}>
                    <Digest value={e.acceptedTermsDigest} />
                  </td>
                  <td data-label={t('commerce.approvals.records')}>{e.electronicRecords ? e.electronicRecords.disclosureKey : '—'}</td>
                  <td data-label={t('commerce.approvals.when')}>{shortDate(e.occurredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
