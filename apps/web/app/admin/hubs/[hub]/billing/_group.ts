import type { GroupDef } from '../../../_data/section-types.js';

/** Console navigation group `billing` (built on synthetic fixtures by HUBC-005). */
export const GROUP: GroupDef = {
  id: 'billing',
  sections: [
    { id: 'offers', path: 'billing/offers', read: ['admin.commerce.usage.read'], status: 'demo', screen: 'HC-90' },
    { id: 'prices', path: 'billing/prices', read: ['admin.commerce.usage.read'], status: 'demo', screen: 'HC-91' },
    { id: 'invoices', path: 'billing/invoices', read: ['admin.billing.invoices.read'], status: 'demo', screen: 'HC-92' },
    { id: 'payouts', path: 'billing/payouts', read: ['admin.billing.payouts.read'], status: 'demo', screen: 'HC-93' },
    { id: 'credits', path: 'billing/credits', read: ['admin.commerce.usage.read'], status: 'demo', screen: 'HC-94' },
    { id: 'tax', path: 'billing/tax', read: ['admin.commerce.usage.read'], status: 'demo', screen: 'HC-95' },
  ],
};
