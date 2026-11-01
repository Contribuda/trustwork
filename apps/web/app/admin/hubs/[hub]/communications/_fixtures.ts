import { suppressSmallCount } from '@trustwork/contracts/client';
import { CommunicationsViewSchema, type CommunicationsView } from '../modules/_kit/schemas.js';

/**
 * Section-local fixtures of the communications screens on the US demo hub (HC-120 to HC-123, HUBC-005). Domains use
 * the reserved `.invalid` and `.example` names; the SMS gateway is the fake adapter; rates are aggregates per template
 * and channel, never per person, and there is no open tracking.
 */

const c = suppressSmallCount;

export const US_COMMUNICATIONS: CommunicationsView = CommunicationsViewSchema.parse({
  domains: [
    { domain: 'mail.us-demo.example', spf: 'pass', dkim: 'pass', dmarc: 'pass', replyTo: 'help@us-demo.example', checkedAt: '2026-10-31T06:00:00Z' },
    { domain: 'news.us-demo.example', spf: 'pass', dkim: 'pending', dmarc: 'fail', replyTo: 'editors@us-demo.example', checkedAt: '2026-10-31T06:00:00Z' },
  ],
  sms: { registration: 'brand_pending', mode: 'fake' },
  templates: [
    { key: 'claim_decided', category: 'transactional', channel: 'email', version: 3, status: 'active', locales: ['en', 'es'], preview: { text: 'Your claim for Example Builders (demo) was approved.', lang: 'en' } },
    { key: 'price_change_notice', category: 'legal', channel: 'email', version: 1, status: 'draft', locales: ['en'], preview: { text: 'The price of Pro (person) changes on December 1.', lang: 'en' } },
    { key: 'weekly_digest', category: 'digest', channel: 'email', version: 2, status: 'paused', locales: ['en', 'es'], preview: { text: 'This week in San Diego construction (demo).', lang: 'en' } },
    { key: 'quote_received', category: 'transactional', channel: 'sms', version: 1, status: 'active', locales: ['en', 'es'], preview: { text: 'You received a new quote (demo).', lang: 'en' } },
  ],
  deliverability: [
    { templateKey: 'claim_decided', channel: 'email', sent: c(412), deliveredPercent: '99.3', bouncePercent: '0.5', complaintPercent: '0' },
    { templateKey: 'weekly_digest', channel: 'email', sent: c(2870), deliveredPercent: '96.1', bouncePercent: '3.4', complaintPercent: '0.2' },
    { templateKey: 'quote_received', channel: 'sms', sent: c(8), deliveredPercent: null, bouncePercent: null, complaintPercent: null },
  ],
  bounceThresholdPercent: '2',
  announcements: [
    { id: 'an-demo-1', kind: 'announcement', title: { text: 'New: plan templates for kitchen remodels (demo)', lang: 'en' }, audience: 'opted_in', audienceSize: c(940), lawfulBasis: 'consent', state: 'draft', at: '2026-10-31T09:00:00Z' },
    { id: 'ln-demo-1', kind: 'legal_notice', title: { text: 'Privacy notice version 2 (demo)', lang: 'en' }, audience: 'all_participants', audienceSize: c(2310), lawfulBasis: 'legal_obligation', state: 'scheduled', at: '2026-11-02T16:00:00Z' },
  ],
  quietHours: { from: '21:00', to: '08:00' },
});
