/**
 * Commerce contracts for the web app (WEB-002): the COM-001 and COM-002 slice layers (`commerce.ts`, `deals.ts`) are not
 * exported from `@trustwork/contracts/client`, so this module re-exports them the way the API modules do
 * (`apps/api/src/modules/procurement/deps.ts`, `sales/deps.ts`). Server modules import values from here; client
 * components import types only (`import type`), so the capability registries these files build never reach a browser
 * bundle.
 */
export * from '../../../../packages/contracts/src/commerce.js';
export * from '../../../../packages/contracts/src/deals.js';
