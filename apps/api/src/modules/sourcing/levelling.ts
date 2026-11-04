import { computeDigest, convertMoney, type Digest, type ExchangeRateSnapshot, type Money, type QuoteVersionPayload, type RfqVersionPayload } from '../../deps/contracts.js';
import { ApiError } from '../../common/errors.js';
import { BidLevelSheetPayloadSchema, KeySchema, type BidLevelSheetPayload, type QuoteVersionRow } from './deps.js';

/**
 * Pure levelling rules (PRC-004). A sheet quotes what the quote says: a cell repeats the stored line exactly (converted
 * with the sheet's dated snapshot when the currency differs), the buyer's own estimates live in `adjustments`, labelled,
 * and `comparable` is derived from the stored version, never taken from the client. There is no weighting and no
 * payment input: nothing here reads anything but the RFQ version and the quote versions.
 */
type Column = BidLevelSheetPayload['columns'][number];
type Cell = BidLevelSheetPayload['cells'][number];
type QuoteColumn = Extract<Column, { kind: 'quote_version' }>;

export function sheetDigest(rfqVersionId: string, payload: BidLevelSheetPayload): Digest {
  return computeDigest({ kind: 'trustwork.bid_level_sheet', version: 1, rfqVersionId, payload });
}

/** Stale, withdrawn, superseded or expired versions are pinned for the record but never compared. */
export function columnState(row: QuoteVersionRow, rfqVersionId: string, now: Date): { comparable: boolean; staleReason: 'rfq_amended' | 'rfq_closed' | null } {
  const staleReason = row.stale_reason ?? (row.rfq_version_id !== rfqVersionId ? 'rfq_amended' : null);
  const live = (row.status === 'sent' || row.status === 'accepted') && row.valid_until !== null && new Date(row.valid_until).getTime() > now.getTime();
  return { comparable: staleReason === null && live, staleReason };
}

/** A money value in the sheet's currency, or null when no dated snapshot converts it. */
function inSheetCurrency(money: Money, currency: string, snapshot: ExchangeRateSnapshot | null): Money | null {
  if (money.currency === currency) return money;
  if (snapshot && snapshot.base === money.currency && snapshot.quote === currency) return convertMoney(money, snapshot);
  return null;
}

const lineFor = (payload: QuoteVersionPayload, rfqLineKey: string) => payload.lines.find((l) => l.rfqLineId === rfqLineKey);

function expectedCell(columnKey: string, rfqLineKey: string, quote: QuoteVersionPayload, currency: string, snapshot: ExchangeRateSnapshot | null): Cell {
  const line = lineFor(quote, rfqLineKey);
  const empty = { columnKey, rfqLineKey, normalizedQuantity: null, conversionRuleRef: null, unitPrice: null, lineTotal: null, alternate: false, leadTimeDays: null, carbonKgCo2e: null };
  if (!line) return { ...empty, excluded: true };
  return {
    ...empty, excluded: false, normalizedQuantity: line.quantity, unitPrice: inSheetCurrency(line.unitPrice, currency, snapshot), lineTotal: inSheetCurrency(line.lineTotal, currency, snapshot),
    alternate: line.substitution !== null,
  };
}

const sameMoney = (a: Money | null, b: Money | null) => (a === null ? b === null : b !== null && a.currency === b.currency && BigInt(a.minorUnits) === BigInt(b.minorUnits));
const sameQuantity = (a: Cell['normalizedQuantity'], b: Cell['normalizedQuantity']) => (a === null ? b === null : b !== null && a.value === b.value && a.unit === b.unit);

/** Starts a sheet from the sent versions: one column per version, one cell per RFQ line, no estimates. */
export function sheetTemplate(rfqVersionId: string, rfq: RfqVersionPayload, versions: readonly QuoteVersionRow[], now: Date): BidLevelSheetPayload {
  const keys = rfq.lines.map((l) => l.lineId).filter((id) => KeySchema.safeParse(id).success);
  const columns: Column[] = versions.map((v) => {
    const state = columnState(v, rfqVersionId, now);
    const priced = (v.payload as QuoteVersionPayload).currency === rfq.currency;
    return { kind: 'quote_version', key: `q-${v.id.toLowerCase()}`, quoteVersionId: v.id, version: v.version, digest: { algorithm: 'trustwork-digest-1', value: v.digest as string }, comparable: state.comparable && priced, staleReason: state.staleReason };
  });
  const cells = versions.flatMap((v) => keys.map((key) => expectedCell(`q-${v.id.toLowerCase()}`, key, v.payload as QuoteVersionPayload, rfq.currency, null)));
  return BidLevelSheetPayloadSchema.parse({ columns, cells, adjustments: [], currency: rfq.currency, exchangeRateSnapshot: null });
}

/**
 * Checks a payload against the stored versions and returns it with `comparable` and `staleReason` taken from them. A
 * comparable column must carry a cell for every line its quote prices, each repeating the quote exactly; a quantity
 * differs from the quote only by citing a conversion rule.
 */
export function checkedPayload(input: BidLevelSheetPayload, rfqVersionId: string, rfq: RfqVersionPayload, versions: ReadonlyMap<string, QuoteVersionRow>, now: Date): BidLevelSheetPayload {
  const rfqLines = new Set(rfq.lines.map((l) => l.lineId));
  const refuse = (reason: string, message: string): never => { throw new ApiError('validation.schema', message, { reason }); };
  const columns = input.columns.map((column): Column => {
    if (column.kind !== 'quote_version') return refuse('captured_quote_unavailable', 'captured quotes arrive with document intake');
    const row = versions.get(column.quoteVersionId);
    if (!row || row.digest === null) throw new ApiError('commercial.digest_mismatch', 'a column pins a sent version of a quote on this RFQ', { reason: 'pin_mismatch' });
    if (row.version !== column.version || row.digest !== column.digest.value) throw new ApiError('commercial.digest_mismatch', 'the pinned digest is not the stored one', { reason: 'pin_mismatch' });
    const state = columnState(row, rfqVersionId, now);
    const quote = row.payload as QuoteVersionPayload;
    const convertible = quote.currency === input.currency || (input.exchangeRateSnapshot?.base === quote.currency && input.exchangeRateSnapshot.quote === input.currency);
    return { ...column, comparable: state.comparable && convertible, staleReason: state.staleReason } satisfies QuoteColumn;
  });
  for (const cell of input.cells) {
    if (!rfqLines.has(cell.rfqLineKey)) refuse('unknown_line', 'a cell names a line of the RFQ version');
    const column = columns.find((c) => c.key === cell.columnKey) as QuoteColumn;
    const quote = (versions.get(column.quoteVersionId) as QuoteVersionRow).payload as QuoteVersionPayload;
    const expected = expectedCell(cell.columnKey, cell.rfqLineKey, quote, input.currency, input.exchangeRateSnapshot);
    if (cell.excluded !== expected.excluded || cell.alternate !== expected.alternate || !sameMoney(cell.unitPrice, expected.unitPrice) || !sameMoney(cell.lineTotal, expected.lineTotal)) {
      refuse('cell_differs_from_quote', 'a cell repeats the quote exactly; buyer estimates go in adjustments');
    }
    if (cell.conversionRuleRef === null && !sameQuantity(cell.normalizedQuantity, expected.normalizedQuantity)) refuse('cell_differs_from_quote', 'a changed quantity cites its conversion rule');
  }
  for (const column of columns as QuoteColumn[]) {
    if (!column.comparable) continue;
    const quote = (versions.get(column.quoteVersionId) as QuoteVersionRow).payload as QuoteVersionPayload;
    for (const line of quote.lines) {
      if (line.rfqLineId === null || !rfqLines.has(line.rfqLineId)) continue;
      if (!input.cells.some((c) => c.columnKey === column.key && c.rfqLineKey === line.rfqLineId)) refuse('cell_missing', 'a comparable column carries every line its quote prices');
    }
  }
  return BidLevelSheetPayloadSchema.parse({ ...input, columns });
}
