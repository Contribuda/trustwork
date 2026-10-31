import type { Money, QuoteVersionPayload, RfqVersionPayload } from '@trustwork/contracts/client';
import { t } from '@/app/_lib/i18n';
import { fromMinor, timestampToLocal } from './amounts';
import { CommandForm, type CommandButton } from './CommandForm';
import { CheckField, Field, Group, Hidden, LinesFields, SelectField, TextAreaField, type Option } from './fields';
import { money, quantity, unitSymbol } from './format';
import { regionOptions } from './options';

/**
 * Server-rendered commerce commands (WEB-002): each wraps the client `CommandForm` around native fields, so only the
 * small generic form reaches the browser. Paths and payload bases come from the projections the page already read.
 */
type Variant = CommandButton['variant'];
const DISCLOSURE = 'trustwork.electronic-records.v1';

/** A command behind a confirmation dialog; Cancel comes first and gets the focus. */
export function ConfirmCommand({ label, title, body, path, payload, demo, variant = 'secondary', destructive, redirect, success }: { label: string; title: string; body: string; path: `/v1/${string}`; payload: Record<string, unknown>; demo: boolean; variant?: Variant; destructive?: boolean; redirect?: { base: string; key: string } | { to: string }; success?: string }) {
  return (
    <CommandForm path={path} base={payload} shape={{ kind: 'plain' }} demo={demo} label={label} buttons={[{ label, variant, confirm: { title, body, label, ...(destructive ? { destructive } : {}) } }]} {...(redirect ? { redirect } : {})} {...(success ? { success } : {})} />
  );
}

/** A command that needs a short reason (amendments, closing, withdrawals, declines), behind a disclosure. */
export function ReasonCommand({ label, title, body, reasonLabel, path, payload, field = 'reason', demo, destructive }: { label: string; title: string; body: string; reasonLabel: string; path: `/v1/${string}`; payload: Record<string, unknown>; field?: string; demo: boolean; destructive?: boolean }) {
  return (
    <details className="cm-disclosure">
      <summary>{label}</summary>
      <CommandForm path={path} base={payload} shape={{ kind: 'reason', field }} demo={demo} label={label} buttons={[{ label, variant: destructive ? 'danger' : 'secondary', confirm: { title, body, label, ...(destructive ? { destructive } : {}) } }]}>
        <p className="ws-muted">{body}</p>
        <TextAreaField label={reasonLabel} name="reason" required rows={2} />
      </CommandForm>
    </details>
  );
}

/** The open RFQ draft (`POST /v1/rfqs/:id/versions/:versionId`); published versions never reach it. */
export function RfqDraftForm({ rfqId, versionId, revision, payload, demo }: { rfqId: string; versionId: string; revision: number; payload: RfqVersionPayload; demo: boolean }) {
  const local = timestampToLocal(payload.responseDeadline);
  return (
    <CommandForm
      path={`/v1/rfqs/${encodeURIComponent(rfqId)}/versions/${encodeURIComponent(versionId)}`}
      base={{ expectedRevision: revision }}
      shape={{ kind: 'rfqDraft', payload, deadline: { local, value: payload.responseDeadline } }}
      demo={demo}
      label={t('commerce.rfq.saveDraft')}
      buttons={[{ label: t('commerce.rfq.saveDraft'), variant: 'secondary' }]}
      success={t('commerce.rfq.draftSaved')}
    >
      <Field label={t('commerce.need.title')} name="title" defaultValue={payload.title} required />
      <LinesFields lines={payload.lines} strict />
      <SelectField label={t('commerce.rfq.region')} name="region" options={regionOptions(payload.deliveryTerms.location.region)} defaultValue={payload.deliveryTerms.location.region} required />
      <Group label={t('commerce.need.window')}>
        <div className="cm-line__grid">
          <Field label={t('commerce.need.windowFrom')} name="from" type="date" defaultValue={payload.deliveryTerms.window.from.date} required />
          <Field label={t('commerce.need.windowTo')} name="to" type="date" defaultValue={payload.deliveryTerms.window.to.date} required />
        </div>
        <Hidden name="timeZone" value={payload.deliveryTerms.window.from.timeZone} />
      </Group>
      <TextAreaField label={t('commerce.rfq.acceptance')} name="acceptance" defaultValue={payload.acceptanceCriteria} required />
      <TextAreaField label={t('commerce.rfq.paymentTerms')} name="payment" defaultValue={payload.paymentTermsRequested} rows={2} />
      <Field label={t('commerce.rfq.deadlineUtc')} name="deadline" type="datetime-local" defaultValue={local} required />
    </CommandForm>
  );
}

/** Invites a supplier to the current published version; sourced pages are listed but cannot be invited. */
export function InviteForm({ rfqId, rfqVersionId, candidates, demo }: { rfqId: string; rfqVersionId: string; candidates: Array<{ value: string; label: string; disabled: boolean }>; demo: boolean }) {
  const options: Option[] = [{ value: '', label: t('commerce.invite.placeholder') }, ...candidates];
  return (
    <CommandForm path={`/v1/rfqs/${encodeURIComponent(rfqId)}/invitations`} base={{ rfqId, rfqVersionId }} shape={{ kind: 'invite' }} demo={demo} label={t('commerce.invite.title')} buttons={[{ label: t('commerce.invite.submit') }]} success={t('commerce.invite.done')}>
      <SelectField label={t('commerce.invite.supplier')} name="supplier" options={options} hint={t('commerce.invite.outreachNote')} required />
    </CommandForm>
  );
}

/** The buyer-private record (`POST /v1/rfqs/:id/private`): budget ceiling and notes, never shown to suppliers. */
export function PrivateForm({ rfqId, revision, currency, ceiling, notes, demo }: { rfqId: string; revision: number; currency: string; ceiling: Money | null; notes: string; demo: boolean }) {
  const code = ceiling?.currency ?? currency;
  return (
    <CommandForm path={`/v1/rfqs/${encodeURIComponent(rfqId)}/private`} base={{ expectedRevision: revision }} shape={{ kind: 'private', currency: code }} demo={demo} label={t('commerce.rfq.budgetCeiling')} buttons={[{ label: t('commerce.rfq.savePrivate'), variant: 'secondary' }]} success={t('commerce.rfq.privateSaved')}>
      <Field label={t('commerce.rfq.budgetCeilingIn', { currency: code })} name="ceiling" defaultValue={ceiling ? fromMinor(ceiling.minorUnits, ceiling.currency) : ''} inputMode="decimal" />
      <TextAreaField label={t('commerce.rfq.internalNotes')} name="notes" defaultValue={notes} />
    </CommandForm>
  );
}

/** A structured request on exact lines of the exact sent version; the supplier answers with a new version. */
export function AmendmentForm({ quoteId, versionId, currency, lines, demo }: { quoteId: string; versionId: string; currency: string; lines: Array<{ lineId: string; label: string }>; demo: boolean }) {
  return (
    <CommandForm path={`/v1/quotes/${encodeURIComponent(quoteId)}/amendment-requests`} base={{ quoteVersionId: versionId }} shape={{ kind: 'amendment', currency }} demo={demo} label={t('commerce.negotiation.requestTitle')} buttons={[{ label: t('commerce.negotiation.request') }]} success={t('commerce.negotiation.requested')}>
      <Hidden name="lines" value={String(lines.length)} />
      {lines.map((l, i) => (
        <fieldset key={l.lineId} className="cm-line">
          <legend>{l.label}</legend>
          <Hidden name={`line.${i}.lineId`} value={l.lineId} />
          <div className="cm-line__grid">
            <Field label={t('commerce.negotiation.targetPrice', { n: i + 1, currency })} name={`line.${i}.price`} inputMode="decimal" />
            <Field label={t('commerce.negotiation.reason', { n: i + 1 })} name={`line.${i}.reason`} />
          </div>
        </fieldset>
      ))}
      <Field label={t('commerce.negotiation.targetTotal', { currency })} name="total" inputMode="decimal" />
    </CommandForm>
  );
}

type Ref = { id: string; version: number; digest: { algorithm: 'trustwork-digest-1'; value: string } };

/** Acceptance of exact terms (`POST /v1/agreements`), with consent to electronic records. Not yet an order. */
export function AcceptTermsForm({ rfqId, quoteRef, rfqRef, quoteRevision, supplier, gross, demo, orderHref }: { rfqId: string; quoteRef: Ref; rfqRef: Ref; quoteRevision: number; supplier: string; gross: string | null; demo: boolean; orderHref: string }) {
  const title = t('commerce.accept.title', { supplier });
  return (
    <CommandForm
      path="/v1/agreements"
      base={{ rfqId, quoteVersion: quoteRef, rfqVersion: rfqRef, expectedRevision: quoteRevision }}
      shape={{ kind: 'accept' }}
      demo={demo}
      label={title}
      buttons={[{ label: t('commerce.accept.submit'), confirm: { title, body: t('commerce.accept.body'), label: t('commerce.accept.submit') } }]}
      redirect={{ to: orderHref }}
    >
      <dl className="ws-facts">
        <div>
          <dt>{t('commerce.accept.quoteVersion')}</dt>
          <dd>
            {quoteRef.version} · <code className="cm-digest">{quoteRef.digest.value.slice(0, 12)}</code>
          </dd>
        </div>
        <div>
          <dt>{t('commerce.accept.rfqVersion')}</dt>
          <dd>
            {rfqRef.version} · <code className="cm-digest">{rfqRef.digest.value.slice(0, 12)}</code>
          </dd>
        </div>
        <div>
          <dt>{t('commerce.totals.gross')}</dt>
          <dd>{gross ?? t('commerce.compare.noTotal')}</dd>
        </div>
      </dl>
      <p className="ws-note">{t('commerce.accept.notOrder')}</p>
      <ConsentFields />
    </CommandForm>
  );
}

export function ConsentFields() {
  return (
    <>
      <Hidden name="disclosureKey" value={DISCLOSURE} />
      <CheckField label={t('commerce.consent.label')} name="consent" hint={t('commerce.consent.disclosure', { key: DISCLOSURE })} />
    </>
  );
}

/** Places the order on accepted terms: the total comes from the immutable quote on the server; the budget is reserved atomically. */
export function PlaceOrderForm({ agreementId, rfqId, quoteVersion, rfqVersion, revision, demo }: { agreementId: string; rfqId: string; quoteVersion: Ref; rfqVersion: Ref; revision: number; demo: boolean }) {
  return (
    <CommandForm
      path={`/v1/agreements/${encodeURIComponent(agreementId)}/orders`}
      base={{ action: 'place_order', context: { kind: 'rfq', id: rfqId }, agreementId, quoteVersion, rfqVersion, expectedRevision: revision }}
      shape={{ kind: 'placeOrder' }}
      demo={demo}
      label={t('commerce.order.place')}
      buttons={[{ label: t('commerce.order.place') }]}
    >
      <Field label={t('commerce.order.budget')} name="budget" required hint={t('commerce.order.budgetHint')} />
      <Field label={t('commerce.order.reference')} name="reference" />
    </CommandForm>
  );
}

/** The seller states the exact digest it accepts and consents to electronic records; buyer selection is not seller acceptance. */
export function SellerAcceptForm({ agreementId, revision, digest, demo }: { agreementId: string; revision: number; digest: { algorithm: 'trustwork-digest-1'; value: string }; demo: boolean }) {
  const title = t('commerce.sellerOrder.acceptTitle');
  return (
    <CommandForm
      path={`/v1/agreements/${encodeURIComponent(agreementId)}/accept`}
      base={{ expectedRevision: revision, acceptedTermsDigest: digest }}
      shape={{ kind: 'accept' }}
      demo={demo}
      label={title}
      buttons={[{ label: t('commerce.sellerOrder.accept'), confirm: { title, body: t('commerce.sellerOrder.acceptBody', { digest: digest.value.slice(0, 12) }), label: t('commerce.sellerOrder.accept') } }]}
    >
      <ConsentFields />
    </CommandForm>
  );
}

/**
 * The seller's quote draft: lines prefilled from the pinned RFQ version (never re-entered), exact prices, taxes, an
 * alternative per line where the buyer allows one, milestones, terms, validity; floors and notes are the seller's
 * private record, saved separately and never sent. "Send" saves first, then freezes the version.
 */
export function QuoteDraftForm({ quoteId, versionId, version, revision, privateRevision, payload, rfqLines, floors, notes, demo }: { quoteId: string; versionId: string; version: number; revision: number; privateRevision: number; payload: QuoteVersionPayload; rfqLines: Array<{ lineId: string; description: string; alternativesAllowed: boolean; quantity: { value: string; unit: string } }>; floors: Record<string, Money>; notes: string; demo: boolean }) {
  const currency = payload.currency;
  const local = timestampToLocal(payload.validity.until);
  const taxes: Option[] = [
    { value: 'none', label: t('commerce.tax.none') },
    { value: 'vat', label: t('commerce.tax.vat') },
    { value: 'other', label: t('commerce.tax.other') },
  ];
  const milestones = [...payload.deliveryTerms.milestones, { description: '', due: { date: '', timeZone: '' } }];
  return (
    <CommandForm
      path={`/v1/quotes/${encodeURIComponent(quoteId)}/versions/${encodeURIComponent(versionId)}`}
      base={{ expectedRevision: revision, quoteId, version }}
      shape={{ kind: 'quote', currency, payload, privatePath: `/v1/quotes/${encodeURIComponent(quoteId)}/private`, privateRevision, sendPath: `/v1/quotes/${encodeURIComponent(quoteId)}/send`, validity: { local, value: payload.validity.until } }}
      demo={demo}
      label={t('commerce.quote.title')}
      buttons={[
        { label: t('commerce.quote.save'), intent: 'save', variant: 'secondary' },
        { label: t('commerce.quote.send', { version }), intent: 'send', success: t('commerce.quote.sent', { version }), confirm: { title: t('commerce.quote.sendTitle', { version }), body: t('commerce.quote.sendConfirm'), label: t('commerce.quote.send', { version }) } },
      ]}
      success={t('commerce.quote.saved')}
    >
      <p className="ws-muted">{t('commerce.quote.totalsOnSave')}</p>
      {payload.lines.map((l, i) => {
        const n = i + 1;
        const p = `q.${i}.`;
        const answers = l.rfqLineId ?? l.substitution?.forRfqLineId ?? null;
        const rfqLine = rfqLines.find((r) => r.lineId === answers);
        const floor = floors[l.lineId];
        return (
          <fieldset key={l.lineId} className="cm-line">
            <legend>
              {n}. {rfqLine?.description ?? t('commerce.quote.extraLine')}
            </legend>
            {rfqLine ? <p className="ws-muted">{t('commerce.quote.requested', { quantity: quantity(rfqLine.quantity) })}</p> : null}
            <Hidden name={`${p}unit`} value={l.quantity.unit} />
            <div className="cm-line__grid">
              <Field label={t('commerce.quote.quantity', { n, unit: unitSymbol(l.quantity.unit) })} name={`${p}quantity`} defaultValue={l.quantity.value} inputMode="decimal" required />
              <Field label={t('commerce.quote.unitPrice', { n, currency })} name={`${p}price`} defaultValue={fromMinor(l.unitPrice.minorUnits, currency)} inputMode="decimal" required />
              <SelectField label={t('commerce.quote.taxKind', { n })} name={`${p}tax`} options={taxes} defaultValue={l.tax.kind} />
              <Field label={t('commerce.quote.rate', { n })} name={`${p}rate`} defaultValue={l.tax.ratePercent ?? ''} inputMode="decimal" />
            </div>
            <p className="ws-muted">{t('commerce.quote.lineAmount', { amount: money(l.lineTotal) })}</p>
            {rfqLine?.alternativesAllowed ? (
              <>
                <CheckField label={t('commerce.quote.substitutionToggle', { n })} name={`${p}substitution`} defaultChecked={l.substitution !== null} />
                <Field label={t('commerce.quote.substitutionReason', { n })} name={`${p}reason`} defaultValue={l.substitution?.reason ?? ''} />
              </>
            ) : null}
            <Field label={t('commerce.quote.floor', { n })} name={`${p}floor`} defaultValue={floor ? fromMinor(floor.minorUnits, floor.currency) : ''} inputMode="decimal" hint={t('commerce.quote.floorHint')} />
            {floor && (floor.currency !== currency || BigInt(l.unitPrice.minorUnits) < BigInt(floor.minorUnits)) ? (
              <p className="ws-note--warn" role="status">
                {t('commerce.quote.floorWarning', { n })}
              </p>
            ) : null}
          </fieldset>
        );
      })}
      <p className="cm-totals">
        <span>
          {t('commerce.totals.net')}: <strong>{money(payload.totals.net)}</strong>
        </span>
        <span>
          {t('commerce.totals.tax')}: <strong>{money(payload.totals.tax)}</strong>
        </span>
        <span>
          {t('commerce.totals.gross')}: <strong>{money(payload.totals.gross)}</strong>
        </span>
      </p>
      <Group label={t('commerce.quote.milestones')}>
        <Hidden name="milestones" value={String(milestones.length)} />
        {milestones.map((m, i) => (
          <div key={i} className="cm-line__grid">
            <Field label={t('commerce.quote.milestoneDescription', { n: i + 1 })} name={`m.${i}.description`} defaultValue={m.description} />
            <Field label={t('commerce.quote.milestoneDue', { n: i + 1 })} name={`m.${i}.due`} type="date" defaultValue={m.due.date} />
          </div>
        ))}
        <p className="ws-muted">{t('commerce.quote.milestonesHint')}</p>
      </Group>
      <Field label={t('commerce.quote.location')} name="location" defaultValue={payload.deliveryTerms.location} />
      <TextAreaField label={t('commerce.quote.paymentTerms')} name="paymentTerms" defaultValue={payload.paymentTerms} rows={2} />
      <Field label={t('commerce.quote.validityUtc')} name="validity" type="datetime-local" defaultValue={local} required />
      <TextAreaField label={t('commerce.quote.exclusions')} name="exclusions" defaultValue={payload.exclusions.join('\n')} hint={t('commerce.quote.exclusionsHint')} />
      <Group label={t('commerce.privateLabel')}>
        <TextAreaField label={t('commerce.quote.notes')} name="notes" defaultValue={notes} rows={2} />
      </Group>
    </CommandForm>
  );
}
