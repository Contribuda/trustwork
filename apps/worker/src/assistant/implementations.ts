import { isDeepStrictEqual } from 'node:util';
import type { EffectImplementationDeclaration } from '../../../../packages/contracts/src/agent-modules.js';
import { ProviderRejectedError } from './providers.js';
import type { EffectProvider, EffectRequest, EffectResponse, LookupResult } from './providers.js';

/** A code-owned implementation. Never construct this from model output, transport input or a database declaration. */
export interface EffectImplementation {
  readonly declaration: EffectImplementationDeclaration;
  submit(request: EffectRequest, signal: AbortSignal): Promise<EffectResponse>;
  lookup(correlationKey: string): Promise<LookupResult>;
}

/** Capture the actual implementation methods and its payload projection once at worker composition. */
export function defineEffectImplementation(declaration: EffectImplementationDeclaration, provider: EffectProvider,
  projectPayload: (input: unknown) => unknown): EffectImplementation {
  if (declaration.provider !== provider.name || declaration.egress !== 'none') throw new Error('owning effect/egress authority unavailable');
  const frozen = Object.freeze({ ...declaration, contextKinds: Object.freeze([...declaration.contextKinds]), privateDataClasses: Object.freeze([...declaration.privateDataClasses]) });
  const submit = provider.submit.bind(provider);
  const lookup = provider.lookup.bind(provider);
  return Object.freeze({ declaration: frozen,
    submit: (request: EffectRequest, signal: AbortSignal) => {
      if (request.operation !== frozen.operation) throw new Error('effect operation does not match code declaration');
      let payload: unknown;
      try { payload = projectPayload(request.payload); }
      catch { throw new ProviderRejectedError('code-owned payload contract rejected the effect'); }
      return submit({ ...request, payload }, signal);
    },
    lookup,
  });
}

/** Equal names never authorize: every immutable declaration field must match the installed code. */
export function effectImplementations(implementations: readonly EffectImplementation[]) {
  const installed = new Map<string, EffectImplementation>();
  for (const implementation of implementations) {
    if (installed.has(implementation.declaration.id)) throw new Error('duplicate effect implementation');
    installed.set(implementation.declaration.id, implementation);
  }
  return (declaration: EffectImplementationDeclaration | null): EffectImplementation | null => {
    if (!declaration) return null;
    const implementation = installed.get(declaration.id);
    return implementation && isDeepStrictEqual(declaration, implementation.declaration) ? implementation : null;
  };
}
