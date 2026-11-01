import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from '../../deps/contracts.js';
import type { Transaction } from '../../deps/data.js';
import { ApiError } from '../../common/errors.js';
import type { RequestState } from '../../common/request.js';
import type { AppContext } from '../identity/context.js';
import type { PrincipalService } from '../identity/principal.service.js';
import { requireParticipantCapability } from './service-authority.js';

export interface ServiceCapabilityBinding {
  capabilityId: string;
  /** Exact owning resource lookup; never an arbitrary caller-supplied principal. */
  company?: (trx: Transaction, principal: Principal, args: readonly unknown[]) => Promise<string | null>;
}
export type ServiceCapabilityBindings<T> = Partial<Record<Extract<keyof T, string>, ServiceCapabilityBinding>>;

/**
 * Adds the shared gate inside the owning service's existing principal transaction, preserving its authorizers,
 * projections, fee confirmation and idempotency completion. No alternate domain implementation or worker session.
 * AsyncLocalStorage binds concurrent invocations independently; missing method bindings are denied.
 */
export function bindServiceCapabilities<T extends object>(
  ctx: AppContext, principals: PrincipalService, bindings: ServiceCapabilityBindings<T>, create: (principals: PrincipalService) => T,
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
          const company = await current.binding.company?.(trx, principal, current.args) ?? null;
          await requireParticipantCapability(ctx, trx, principal, current.binding.capabilityId, company);
          return execute(trx, principal);
        });
      };
    },
  });
  const service = create(guardedPrincipals);
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
