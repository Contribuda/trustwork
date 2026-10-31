import { z } from 'zod';
import * as approvals from './approvals.js';
import * as commands from './commands.js';
import * as costControl from './cost-control.js';
import * as documents from './documents.js';
import * as equivalence from './equivalence.js';
import * as intake from './intake.js';
import * as invoices from './invoices.js';
import * as orders from './orders.js';
import * as payments from './payments.js';
import * as receiving from './receiving.js';
import * as requisitions from './requisitions.js';
import * as settings from './settings.js';
import * as sourcing from './sourcing.js';
import * as stock from './stock.js';
import * as suppliers from './suppliers.js';
import { SUPPLY_CONTRACT_VERSION } from './common.js';

/**
 * Procurement and supply contracts (PRC-000): one directory, contract name `supply` in capability references.
 * Status: Contract. Nothing here is stored, sent or paid; slices PRC-001 … PRC-023 build on these shapes.
 */
export * from './common.js';
export * from './approvals.js';
export * from './requisitions.js';
export * from './suppliers.js';
export * from './sourcing.js';
export * from './intake.js';
export * from './equivalence.js';
export * from './cost-control.js';
export * from './orders.js';
export * from './receiving.js';
export * from './stock.js';
export * from './invoices.js';
export * from './payments.js';
export * from './documents.js';
export * from './settings.js';
export * from './commands.js';
export * from './capabilities.js';
export * from './extensions.js';

const isSchema = (v: unknown): v is z.ZodType => v instanceof z.ZodType;
/** Every exported `…Schema` of the directory by name (capability references resolve against this map). */
export const SUPPLY_SCHEMAS: Readonly<Record<string, z.ZodType>> = Object.fromEntries(
  [approvals, requisitions, suppliers, sourcing, intake, equivalence, costControl, orders, receiving, stock, invoices, payments, documents, settings, commands]
    .flatMap((m) => Object.entries(m))
    .filter(([name, value]) => name.endsWith('Schema') && isSchema(value)),
);

/** Draft 2020-12 JSON Schemas with a versioned `$id`; refinements are enforced by Zod only. */
export function supplyJsonSchemas(): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, schema] of Object.entries(SUPPLY_SCHEMAS)) {
    const json = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
    out[name] = { $id: `urn:trustwork:contracts:supply:v${SUPPLY_CONTRACT_VERSION}:${name.replace(/Schema$/, '')}`, ...json };
  }
  return out;
}
