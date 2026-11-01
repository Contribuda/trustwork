import { computeDigest } from '@trustwork/contracts';
import type { Transaction } from '../../../deps/data.js';
import type { JurisdictionDisclosureBundle } from '../../../../../../packages/contracts/src/jurisdiction.js';

/** Owning OUTR-002 must resolve immutable template identity and scope; an HTTP payload is not this port. */
export interface ImmutableDisclosureTemplate {
  id: string;
  version: number;
  digest: string;
  policyVersionId: string;
  policyDigest: string;
  variants: Array<{
    jurisdiction: string; locale: string;
    blocks: Array<{ kind: string; locked: boolean; text: string; documentId?: string; bodyDigest?: string }>;
  }>;
}
export interface JurisdictionTemplatePorts {
  loadOwningTemplate(trx: Transaction, templateId: string): Promise<ImmutableDisclosureTemplate | null>;
  loadCurrentDisclosure(trx: Transaction, policyVersionId: string): Promise<JurisdictionDisclosureBundle | null>;
}
const required = ['operator_identification', 'automated_assistant', 'data_sources', 'page_link', 'correct_or_remove', 'unsubscribe'];

/** A validation result, never activation/sending authority. Unconsumed until an owning OUTR runtime exists. */
export async function validateJurisdictionTemplate(trx: Transaction, ports: JurisdictionTemplatePorts, templateId: string) {
  const unavailable = { status: 'unavailable' as const, reasons: ['owning_template_or_current_disclosure_unavailable'] };
  const template = await ports.loadOwningTemplate(trx, templateId);
  if (!template || template.id !== templateId) return unavailable;
  const bundle = await ports.loadCurrentDisclosure(trx, template.policyVersionId);
  if (!bundle || template.policyVersionId !== bundle.policyVersionId || template.policyDigest !== bundle.policyDigest) return unavailable;
  const { digest, ...content } = template;
  if (digest !== computeDigest(content).value) return unavailable;
  const reasons: string[] = [];
  const pairs = new Set(bundle.bindings.map(b => `${b.jurisdiction}:${b.locale}`));
  if (template.variants.length !== pairs.size) reasons.push('template_scope_mismatch');
  for (const jurisdiction of new Set(bundle.bindings.map(b => b.jurisdiction))) {
    for (const locale of bundle.locales) {
      const bindings = bundle.bindings.filter(b => b.jurisdiction === jurisdiction && b.locale === locale);
      const variants = template.variants.filter(v => v.jurisdiction === jurisdiction && v.locale === locale);
      if (bindings.length !== 1 || variants.length !== 1) { reasons.push('complete_language_binding_required'); continue; }
      const binding = bindings[0]!, variant = variants[0]!;
      for (const kind of required) {
        const blocks = variant.blocks.filter(b => b.kind === kind);
        if (blocks.length !== 1 || !blocks[0]!.locked || !blocks[0]!.text.trim()) reasons.push('locked_block_required');
      }
      const text = variant.blocks.find(b => b.kind === 'automated_assistant');
      if (!text || text.text !== binding.body || text.documentId !== binding.documentId || text.bodyDigest !== binding.bodyDigest) reasons.push('exact_disclosure_required');
    }
  }
  return reasons.length ? { status: 'unavailable' as const, reasons: [...new Set(reasons)].sort() }
    : { status: 'validated' as const, templateId, templateVersion: template.version, templateDigest: digest, policyVersionId: bundle.policyVersionId, policyDigest: bundle.policyDigest };
}
