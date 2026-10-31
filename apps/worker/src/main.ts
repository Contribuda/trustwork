import { evaluateDelegation, type Delegation } from '../../../packages/contracts/src/index.js';
const grant: Delegation = { actions: ['prepare'], contextId: 'fixture-project', expiresAt: '2099-01-01T00:00:00Z', revoked: false, ceiling: { currency: 'UZS', minorUnits: '0' } };
const decision = evaluateDelegation(grant, { action: 'place_order', contextId: 'fixture-project', amount: { currency: 'UZS', minorUnits: '100' } }, new Date());
console.log(JSON.stringify({ mode: 'fixture', decision, externalActions: 0, durableQueue: 'not_implemented' }));
