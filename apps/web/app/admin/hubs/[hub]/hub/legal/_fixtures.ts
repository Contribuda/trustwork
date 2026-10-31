import { LegalDocumentSchema, OperatorSchema, type LegalDocument, type Operator } from '../../../../_data/schemas.js';
import { HUB_SAMARKAND_ID, HUB_US_ID } from '../../../../_fixtures/ids.js';

/**
 * Section-local fixtures of HC-13 (ADM-002). The operator is invented ("Example Builders Association (demo)"), its
 * identifier is the `00-0000000` placeholder (an EIN can never start with 00), contacts use `example.invalid`, and the
 * screening result is labelled as coming from the fake adapter.
 */
export const OPERATORS: readonly Operator[] = [
  OperatorSchema.parse({
    synthetic: true,
    hubId: HUB_US_ID,
    legalName: 'Example Builders Association (demo)',
    form: 'nonprofit_association',
    identifier: { kind: 'US-EIN', value: '00-0000000' },
    address: '100 Example Street, San Diego, CA 00000 (synthetic)',
    legalContact: 'legal@us-demo.example.invalid',
    abuseContact: 'abuse@us-demo.example.invalid',
    screening: { mode: 'fake', result: 'no_match', at: '2026-10-28T10:00:00Z' },
  }),
];

const doc = (d: Omit<LegalDocument, 'synthetic' | 'hubId'> & { hubId?: string }) => LegalDocumentSchema.parse({ hubId: HUB_US_ID, synthetic: true, ...d });

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [
  doc({ id: 'ld-us-terms-1', kind: 'terms', version: 1, status: 'counsel_approved', locales: ['en', 'es'], counselApproval: { by: 'Synthetic Counsel', firm: 'Example Law Office (demo)', at: '2026-10-15T12:00:00Z', scope: 'Terms of use for a demo-only hub' }, effectiveFrom: null }),
  doc({ id: 'ld-us-privacy-1', kind: 'privacy_notice', version: 1, status: 'superseded', locales: ['en'], counselApproval: { by: 'Synthetic Counsel', firm: 'Example Law Office (demo)', at: '2026-10-15T12:00:00Z', scope: 'Privacy notice, English only' }, effectiveFrom: '2026-10-16T00:00:00Z' }),
  doc({ id: 'ld-us-privacy-2', kind: 'privacy_notice', version: 2, status: 'counsel_approved', locales: ['en', 'es'], counselApproval: { by: 'Synthetic Counsel', firm: 'Example Law Office (demo)', at: '2026-10-29T12:00:00Z', scope: 'Privacy notice with state privacy rights, English and Spanish' }, effectiveFrom: null }),
  doc({ id: 'ld-us-community-1', kind: 'community_rules', version: 1, status: 'draft', locales: ['en'], counselApproval: null, effectiveFrom: null }),
  doc({ hubId: HUB_SAMARKAND_ID, id: 'ld-sam-terms-1', kind: 'terms', version: 1, status: 'draft', locales: ['uz-Latn'], counselApproval: null, effectiveFrom: null }),
];
