import { z } from 'zod';
import { JurisdictionAgentSettingsSchema, jurisdictionOverrideProblems } from '../../../../../../packages/contracts/src/jurisdiction.js';
import { AddedRestrictedPlaceSchema } from '../../../../../../packages/contracts/src/hub-core.js';
import type { Transaction } from '../../../deps/data.js';
import { ApiError } from '../../../common/errors.js';
import { hubConfig, hubs, type CommandContext } from '../deps.js';
import { RepositoryJurisdictionPacks, type JurisdictionPackSource } from './pack-source.js';

/** Preserve HUB-001's add-only restrictions in the same domain version. No opaque policy passthrough here. */
export const JurisdictionPayloadSchema = z.strictObject({
  addedRestrictedPlaces: z.array(AddedRestrictedPlaceSchema).max(200).optional(),
  agentSettings: JurisdictionAgentSettingsSchema,
});

/**
 * Draft storage and read-only preflight, under the existing principal transaction and RLS. No activation method:
 * activation needs database enforcement (including concurrent hub-language changes) and runtime integration first.
 * Preflight is diagnostic evidence, not an authorization token. No public or participant projection is exposed.
 */
export class JurisdictionConfiguration {
  constructor(private readonly source: JurisdictionPackSource = new RepositoryJurisdictionPacks()) {}

  async draft(trx: Transaction, cmd: CommandContext, hubId: string, input: unknown) {
    const payload = JurisdictionPayloadSchema.parse(input);
    return hubConfig.draft(trx, cmd, hubId, 'jurisdiction', payload);
  }

  async preflight(trx: Transaction, hubId: string, versionId: string) {
    const version = await hubConfig.get(trx, versionId);
    if (!version || version.hub_id !== hubId || version.domain !== 'jurisdiction') throw new ApiError('access.not_found', 'access.not_found');
    const profile = await hubs.profile(trx, hubId);
    if (!profile) throw new ApiError('access.not_found', 'access.not_found');
    const payload = JurisdictionPayloadSchema.parse(version.payload);
    const problems: string[] = ['database_activation_guard_missing', 'runtime_jurisdiction_binding_missing'];
    const inspections = payload.agentSettings.jurisdictions.map((setting) => {
      for (const locale of profile.locales) {
        if (!setting.policy.disclosureTextKeys[locale]) problems.push(`disclosure_locale_missing:${locale}`);
        if (!setting.policy.legalTextKeys[locale]?.length) problems.push(`legal_locale_missing:${locale}`);
      }
      const inspected = this.source.inspect(setting.jurisdiction);
      if (inspected.jurisdiction !== setting.jurisdiction) problems.push('baseline_jurisdiction_mismatch');
      if (inspected.baseline.status === 'unknown') problems.push(...inspected.baseline.reasons);
      else problems.push(...jurisdictionOverrideProblems(setting, inspected.baseline.baseline, profile.locales));
      return inspected;
    });
    return { status: 'blocked' as const, versionId: version.id, payloadDigest: version.payload_digest, problems: [...new Set(problems)].sort(), inspections };
  }
}
