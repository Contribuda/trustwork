import type { Transaction } from '@trustwork/data';
import { computeDigest } from '../../../../packages/contracts/src/common/digest.js';
import { ExtensionCallOutputSchema, extensionInputViolations, isExtensionEffect, type ExtensionCallInput, type ExtensionEffectDeclaration } from '../../../../packages/contracts/src/agent-extensions.js';
import { agentExtensionWorker } from '../../../../packages/data/src/repositories/agent-extensions.js';
import { ProviderRejectedError, type EffectRequest, type EffectResponse, type LookupResult } from '../assistant/providers.js';
import { installedAdapter, type ExtensionAdapter, type InstalledExtensionAdapter } from './adapters.js';

/**
 * Extension effects (AGT-023). By the time one runs, the shared runtime has already checked the mandate, the approval, the
 * budget reservation, the authorization epochs and every kill switch (`agent_modules_enter_effect`, in this transaction).
 * This adds what only an extension has: the call gate for egress and caps, the pinned version, the adapter, and the audit.
 *
 * Whatever an adapter returns is untrusted data. It is parsed, digested and dropped: nothing it says is stored, shown to
 * staff or read as a command, so there is no path from adapter text to an action.
 */
export interface ExtensionEffect {
  submit(request: EffectRequest, signal: AbortSignal): Promise<EffectResponse>;
  lookup(correlationKey: string): Promise<LookupResult>;
}
export interface ExtensionEffects {
  /** Call first in the dispatch transaction: see `agent_extensions_lock_gate` for why the order matters. */
  beforeEffect(trx: Transaction, declaration: unknown): Promise<void>;
  forDispatch(trx: Transaction, declaration: unknown, lease: { attemptId: string; jobId: string; fencingToken: string | number }): ExtensionEffect | null;
  forReconciliation(trx: Transaction, declaration: unknown, attemptId: string): ExtensionEffect | null;
}

const digestOf = (value: unknown): string => computeDigest(value).value;

/** The adapter a call may use: the fake on a fake connection, the live adapter on a live one, and nothing else. */
function adapterFor(adapters: readonly InstalledExtensionAdapter[], declaration: ExtensionEffectDeclaration, mode: string | null): ExtensionAdapter | null {
  const installed = installedAdapter(adapters, declaration.extension.adapter);
  if (!installed) return null;
  return mode === 'fake' ? installed.fake : mode === 'live' ? installed.live : null;
}

export function extensionEffects(adapters: readonly InstalledExtensionAdapter[] | (() => readonly InstalledExtensionAdapter[])): ExtensionEffects {
  const installed = () => (typeof adapters === 'function' ? adapters() : adapters);
  return {
    async beforeEffect(trx, declaration) {
      if (isExtensionEffect(declaration)) await agentExtensionWorker.lockGate(trx);
    },
    forDispatch(trx, declaration, lease) {
      if (!isExtensionEffect(declaration)) return null;
      return {
        async submit(request, signal) {
          const { action } = declaration.extension;
          const start = await agentExtensionWorker.beginCall(trx, lease.attemptId, lease.jobId, lease.fencingToken, digestOf(request.payload));
          if (start.refusal !== null) throw new ProviderRejectedError(`extension refused: ${start.refusal}`);
          const refuse = async (reason: string): Promise<never> => {
            await agentExtensionWorker.finishCall(trx, start.callId, 'refused', null, reason);
            throw new ProviderRejectedError(`extension refused: ${reason}`);
          };
          // Checked at proposal too; a declaration is only as good as the last reader.
          if (extensionInputViolations(action, request.payload).length > 0) return refuse('input_invalid');
          const adapter = adapterFor(installed(), declaration, start.connectionMode);
          if (!adapter) return refuse('adapter_unavailable');
          let raw: unknown;
          try {
            raw = await adapter.call({ operation: request.operation, correlationKey: request.correlationKey, input: request.payload as ExtensionCallInput }, signal);
          } catch (error) {
            // The effect may have happened: an unknown outcome goes to reconciliation, never to a retry.
            await agentExtensionWorker.finishCall(trx, start.callId, 'unknown', null);
            throw error;
          }
          const parsed = ExtensionCallOutputSchema.safeParse(raw);
          const output = digestOf(parsed.success ? parsed.data : { refused: true });
          // The participant received nothing usable: the action failed and its reservation is released.
          if (!parsed.success) {
            await agentExtensionWorker.finishCall(trx, start.callId, 'refused', null, 'output_refused');
            return { kind: 'final', result: 'failed', providerReference: start.callId, evidence: 'extension output refused: it did not match the output contract' };
          }
          await agentExtensionWorker.finishCall(trx, start.callId, 'succeeded', output);
          return { kind: 'final', result: 'succeeded', providerReference: start.callId, evidence: `extension output digest ${output}` };
        },
        lookup: () => Promise.resolve({ status: 'unknown' }),
      };
    },
    forReconciliation(trx, declaration, attemptId) {
      if (!isExtensionEffect(declaration)) return null;
      return {
        submit: () => Promise.reject(new ProviderRejectedError('reconciliation never sends')),
        async lookup(correlationKey) {
          // A crash can erase the row that named the connection. With a live adapter installed the fake cannot speak for it, so a person decides.
          const pair = installedAdapter(installed(), declaration.extension.adapter);
          if (!pair || pair.live) return { status: 'unknown' };
          const adapter = pair.fake;
          const found = await adapter.lookup(correlationKey);
          if (!found.found) {
            await agentExtensionWorker.recordReconciled(trx, attemptId, 'failed', null);
            return { status: 'not_found' };
          }
          const parsed = ExtensionCallOutputSchema.safeParse(found.output);
          if (!parsed.success) {
            await agentExtensionWorker.recordReconciled(trx, attemptId, 'failed', null);
            return { status: 'final', result: 'failed', providerReference: attemptId, evidence: 'extension output refused: it did not match the output contract' };
          }
          const output = digestOf(parsed.data);
          await agentExtensionWorker.recordReconciled(trx, attemptId, 'succeeded', output);
          return { status: 'final', result: 'succeeded', providerReference: attemptId, evidence: `extension output digest ${output}` };
        },
      };
    },
  };
}
