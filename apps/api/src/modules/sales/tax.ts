import type { QuoteLine } from '../../deps/contracts.js';
import type { TaxDeterminationInsert } from './deps.js';

/**
 * How the tax of a sent quote line is determined (model 1.5: never a hard-coded rate). This slice records the seller's
 * stated tax term, labelled `seller_stated` with the RFQ delivery region as the jurisdiction when it is a place code;
 * a country-pack or adapter determination (for example US state and local sales tax, INTL-US) plugs in here with
 * `provider: 'pack' | 'adapter'` and its rule reference. Nothing here calls the network.
 */
export interface TaxDeterminationPort {
  determine(line: QuoteLine, context: { region: string | null }): TaxDeterminationInsert;
}

const PLACE_CODE = /^[A-Z]{2}(-[A-Z0-9]{1,3})?(:[a-z0-9][a-z0-9-]{0,62})?$/;
export class SellerStatedTax implements TaxDeterminationPort {
  determine(line: QuoteLine, context: { region: string | null }): TaxDeterminationInsert {
    const rate = line.tax.ratePercent;
    const zero = rate === null || /^0+(\.0+)?$/.test(rate);
    return {
      line_id: line.lineId,
      jurisdiction: context.region && PLACE_CODE.test(context.region) ? context.region : null,
      rule_ref: `seller-stated:${line.tax.kind}`,
      rate: rate !== null && !rate.startsWith('-') ? rate : null,
      included: line.tax.included,
      taxability: line.tax.kind === 'none' ? 'not_applicable' : zero ? 'exempt' : 'taxable',
      exemption_ref: null,
      provider: 'seller_stated',
    };
  }
}
