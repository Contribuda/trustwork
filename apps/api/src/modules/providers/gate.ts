import type { DataPool } from '../../deps/data.js';
import { providerCalls, ProviderCallDecisionSchema, ProviderCallRequestSchema, type ProviderCallDecision, type ProviderCallRequest } from './deps.js';
import { SecretStoreError, type ExternalSecretReader, type SecretSealer, type SecretValue } from './secret-store.js';

/**
 * The call gate every model or provider call passes before anything leaves the node (KEYS-001; LLM-001 builds its
 * gateway on it). `authorize` resolves the most specific active route (extension, then module, then job), applies the
 * kill switches and the egress decision for every data class, and reserves the call's upper-bound cost against every
 * applicable cap under a per-hub lock: a refusal names its reason (`CALL_REFUSAL_REASONS`), and an exhausted cap blocks
 * the next paid call. Try the candidates in order and fall back only on unavailability; settle what the call cost, or
 * release it when nothing was sent. An unknown outcome settles at the full reservation and goes to reconciliation;
 * it is never retried blindly.
 *
 * `withSecret` opens the connection's sealed secret for the duration of one adapter call, only for an open decision
 * that lists that connection; the plaintext never leaves the callback.
 */
export class ProviderCallGate {
  constructor(private readonly pool: DataPool, private readonly sealer: SecretSealer | null, private readonly external: ExternalSecretReader) {}

  async authorize(request: ProviderCallRequest): Promise<ProviderCallDecision> {
    return ProviderCallDecisionSchema.parse(await providerCalls.authorize(this.pool, ProviderCallRequestSchema.parse(request)));
  }

  settle(decisionId: string, input: { connectionId: string; modelId: string; outcome: 'succeeded' | 'failed' | 'unknown'; costMinorUnits: string; inputTokens?: number; outputTokens?: number; images?: number; audioSeconds?: number }) {
    return providerCalls.settle(this.pool, decisionId, input);
  }

  release(decisionId: string) {
    return providerCalls.release(this.pool, decisionId);
  }

  async withSecret<T>(decisionId: string, connectionId: string, fn: (secret: SecretValue | null) => Promise<T>): Promise<T> {
    const sealed = await providerCalls.secret(this.pool, decisionId, connectionId);
    let secret: SecretValue | null = null;
    if (sealed.ciphertext && sealed.iv && sealed.auth_tag && sealed.wrapped_key && sealed.kek_id) {
      if (!this.sealer) throw new SecretStoreError('unconfigured');
      secret = await this.sealer.open({ ciphertext: sealed.ciphertext, iv: sealed.iv, authTag: sealed.auth_tag, wrappedKey: sealed.wrapped_key, kekId: sealed.kek_id },
        { connectionId, version: sealed.secret_version ?? 0 });
    } else if (sealed.credential_store && sealed.credential_ref) {
      secret = await this.external.read(sealed.credential_store, sealed.credential_ref);
    }
    return fn(secret);
  }
}
