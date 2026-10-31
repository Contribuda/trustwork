import type { ParsedList } from './entries.js';
import { parseOfacSlsXml } from './ofac.js';

/**
 * List ingestion adapters: one per export format. A list row names its adapter; the worker refuses a list whose
 * adapter is not registered here. Every adapter here is also an `ENGINE_ADAPTERS` entry with capability
 * `sanctions_list` in `@trustwork/country-packs`, so a country-pack `sanctions` fact can name it for a hub's
 * additional list (tests/screening-lists/adapters.test.ts keeps the two in step). The trade.gov Consolidated
 * Screening List is a query adapter (`consolidatedScreeningList` in the package index), not a list export, and keeps
 * refusing to run without a key.
 */
export interface ListAdapter {
  readonly id: string;
  /** File name extension in `file` mode: `<lists dir>/<code>.<extension>`. */
  readonly extension: string;
  readonly description: string;
  parse(text: string): ParsedList;
}

export const OFAC_SLS_XML_ADAPTER: ListAdapter = {
  id: 'ofac-sls-xml',
  extension: 'xml',
  description: 'OFAC Sanctions List Service export in the classic XML schema (SDN.XML, CONSOLIDATED.XML)',
  parse: parseOfacSlsXml,
};

export const LIST_ADAPTERS: readonly ListAdapter[] = [OFAC_SLS_XML_ADAPTER];

export function findListAdapter(id: string): ListAdapter | null {
  return LIST_ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}
