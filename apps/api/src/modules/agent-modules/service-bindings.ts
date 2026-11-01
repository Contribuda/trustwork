import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { requireParticipantCapability } from './service-authority.js';
import { requirePublicServingContext } from './serving-hub.js';
import type { CapabilityAuthority } from './authority.js';

export interface ServiceCapabilityTarget { capabilityId: string; companyId: string | null }
export type ServiceCapabilityBinding = {
  /** An explicitly inventoried owning authority boundary, never a default for an unknown method. */
  boundary: 'first_party_control' | 'public_projection';
  reason: string;
} | {
  capabilityId: string;
  /** Missing owning mandate adapters never turn a participant command into an authorized agent action. */
  firstPartyOnly?: boolean;
  /** Exact owning resource lookup; never an arbitrary caller-supplied principal. */
  company?: (trx: Transaction, principal: Principal, args: readonly unknown[]) => Promise<string | null>;
} | {
  /** Mixed owning projections require every represented scope; an empty resolution never allows an operation. */
  resolve: (trx: Transaction, principal: Principal, args: readonly unknown[]) => Promise<readonly ServiceCapabilityTarget[]>;
};
export type ServiceCapabilityBindings<T> = Record<Extract<keyof T, string>, ServiceCapabilityBinding>;
export type PublicServiceBoundary = (trx: Transaction) => Promise<void>;

/**
 * Adds the shared gate inside the owning service's existing principal transaction, preserving its authorizers,
 * projections, fee confirmation and idempotency completion. No alternate domain implementation or worker session.
 * AsyncLocalStorage binds concurrent invocations independently; missing method bindings are denied.
 */
export function bindServiceCapabilities<T extends object>(
  ctx: AppContext, principals: PrincipalService, bindings: ServiceCapabilityBindings<T>, create: (principals: PrincipalService, publicBoundary: PublicServiceBoundary) => T,
  authority?: CapabilityAuthority,
): T {
  const invocation = new AsyncLocalStorage<{ binding: ServiceCapabilityBinding; args: readonly unknown[] }>();
  const guardedPrincipals = new Proxy(principals, {
    get(target, key) {
      if (key !== 'runAs') {
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return <R>(state: RequestState, execute: (trx: Transaction, principal: Principal) => Promise<R>): Promise<R> => {
        const current = invocation.getStore();
        if (!current) throw new ApiError('access.forbidden', 'service operation has no capability binding', { reason: 'capability.unknown' });
        return target.runAs(state, async (trx, principal) => {
          if ('boundary' in current.binding) {
            if (current.binding.boundary === 'public_projection') await publicBoundary(trx);
            else if (principal.delegation) throw new ApiError('access.mandate_scope', 'this control requires the person on the first-party surface');
            return execute(trx, principal);
          }
          if ('firstPartyOnly' in current.binding && current.binding.firstPartyOnly && principal.delegation) {
            throw new ApiError('access.mandate_scope', 'owning delegated authority is unavailable');
          }
          const checks = 'resolve' in current.binding ? await current.binding.resolve(trx, principal, current.args) : [{
            capabilityId: current.binding.capabilityId, companyId: await current.binding.company?.(trx, principal, current.args) ?? null,
          }];
          if (checks.length === 0) throw new ApiError('access.forbidden', 'service authority is unavailable', { reason: 'capability.unknown' });
          for (const check of checks) await requireParticipantCapability(ctx, trx, principal, check.capabilityId, check.companyId, authority);
          return execute(trx, principal);
        });
      };
    },
  });
  const publicBoundary: PublicServiceBoundary = async trx => {
    const current = invocation.getStore();
    if (!current || !('boundary' in current.binding) || current.binding.boundary !== 'public_projection') {
      throw new ApiError('access.forbidden', 'public projection has no explicit authority boundary');
    }
    await requirePublicServingContext(trx, ctx.config.publicOrigin);
  };
  const service = create(guardedPrincipals, publicBoundary);
  return new Proxy(service, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      const binding = bindings[key as Extract<keyof T, string>];
      return (...args: unknown[]) => {
        if (!binding) throw new ApiError('access.forbidden', 'service operation has no capability binding', { reason: 'capability.unknown' });
        return invocation.run({ binding, args }, () => Reflect.apply(value, target, args) as unknown);
      };
    },
  });
}
