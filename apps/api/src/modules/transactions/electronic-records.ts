import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { findRepositoryRoot } from '../plans/facets.js';
import { ElectronicRecordsPolicySchema, type ElectronicRecordsPolicy } from '../sales/deps.js';

/**
 * Where the electronic-records policy of the hub comes from (COM-002 step 4). Acceptance of terms and of an order is
 * an electronic record; when the hub requires it, the acceptance carries the participant's affirmative consent to
 * electronic records for the hub's current disclosure, and the acceptance event records the disclosure and its legal
 * basis. The wording of the disclosure is a legal text of the hub (counsel review, HUB-005); the engine records which
 * one was consented to. Nothing here calls the network.
 */
export interface ElectronicRecordsPolicySource {
  current(): ElectronicRecordsPolicy;
}

/** Engine default with no country configured: consent is required, with the engine's generic disclosure and no legal basis cited. */
export const DEFAULT_ELECTRONIC_RECORDS: ElectronicRecordsPolicy = { required: true, disclosureKey: 'trustwork.electronic-records.v1', basis: [] };

export class ConfiguredElectronicRecords implements ElectronicRecordsPolicySource {
  private readonly policy: ElectronicRecordsPolicy;
  constructor(policy: ElectronicRecordsPolicy = DEFAULT_ELECTRONIC_RECORDS) {
    this.policy = ElectronicRecordsPolicySchema.parse(policy);
  }
  current(): ElectronicRecordsPolicy {
    return this.policy;
  }
}

const PackFile = z.object({ code: z.string(), facets: z.object({ eSignature: z.array(z.object({ id: z.string() }).loose()).optional() }).loose().optional() }).loose();
/**
 * The policy a hub in `countryCode` starts from: consent required, and the country pack's e-signature facts as the
 * cited basis (the US pack cites ESIGN, 15 U.S.C. 7001, and the state UETA enactments). A pack without e-signature
 * facts yields the engine default.
 */
export function electronicRecordsFromPack(countryCode: string, root: string | null = findRepositoryRoot()): ElectronicRecordsPolicy {
  const code = countryCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || !root) return DEFAULT_ELECTRONIC_RECORDS;
  const path = join(root, 'packages', 'country-packs', 'packs', `${code.toLowerCase()}.json`);
  if (!existsSync(path)) return DEFAULT_ELECTRONIC_RECORDS;
  const parsed = PackFile.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  const ids = parsed.success ? (parsed.data.facets?.eSignature ?? []).map((f) => f.id).filter((id) => /^[a-z0-9-]{1,80}$/.test(id)) : [];
  if (ids.length === 0) return DEFAULT_ELECTRONIC_RECORDS;
  return ElectronicRecordsPolicySchema.parse({ required: true, disclosureKey: `${code.toLowerCase()}.electronic-records.v1`, basis: ids.slice(0, 20).map((id) => `${code}:eSignature/${id}`) });
}
