import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderReceipt } from './reconcile.js';

/**
 * The provider fake of the restore drill (OPS-003). It plays an external service that honours idempotency keys:
 * every call is logged (calls.jsonl, what reached the provider) and the first call per effect key produces a receipt
 * (receipts.jsonl, what the provider's own records show and an operator would export for reconciliation). It lives
 * outside the database and survives the simulated failure, like a real provider.
 */
export interface ProviderCall { effectKey: string; kind: string; at: string; phase: string }

export class FakeProvider {
  readonly callsPath: string;
  readonly receiptsPath: string;
  phase = 'source';

  constructor(dir: string) {
    this.callsPath = join(dir, 'calls.jsonl');
    this.receiptsPath = join(dir, 'receipts.jsonl');
  }

  call(effectKey: string, kind: string): ProviderReceipt {
    const at = new Date().toISOString();
    appendFileSync(this.callsPath, `${JSON.stringify({ effectKey, kind, at, phase: this.phase } satisfies ProviderCall)}\n`);
    const existing = this.receipts().find((r) => r.effectKey === effectKey);
    if (existing) return existing;
    const receipt: ProviderReceipt = { effectKey, kind, reference: `rcpt-${this.receipts().length + 1}`, at };
    appendFileSync(this.receiptsPath, `${JSON.stringify(receipt)}\n`);
    return receipt;
  }

  calls(): ProviderCall[] {
    return existsSync(this.callsPath) ? readFileSync(this.callsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ProviderCall) : [];
  }

  receipts(): ProviderReceipt[] {
    return existsSync(this.receiptsPath) ? readFileSync(this.receiptsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ProviderReceipt) : [];
  }

  callsFor(jobId: string): ProviderCall[] {
    return this.calls().filter((c) => c.effectKey === `job:${jobId}`);
  }
}
