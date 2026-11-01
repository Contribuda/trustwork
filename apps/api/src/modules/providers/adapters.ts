import type { AdapterTestReport, SyntheticProbe } from './deps.js';
import type { SecretValue } from './secret-store.js';

/**
 * Provider adapters for connection tests (KEYS-001). A test sends only the engine's synthetic probes
 * (`syntheticProbesFor`): the adapter receives the probes, the endpoint and the secret, and nothing else; there is no
 * parameter through which customer data could reach it. Model and provider calls of the product go through the call
 * gate (`ProviderCallGate`) and LLM-001's adapters, which register here as well.
 *
 * The engine ships no live network adapter: `fake` mode always uses the deterministic `FakeProviderAdapter`, `manual`
 * mode records that a person will perform the operation, and a live connection whose adapter is not registered tests
 * as `error` (`adapter_unavailable`), so it can never be enabled by accident.
 */
export interface AdapterTestInput {
  readonly probes: readonly SyntheticProbe[];
  readonly endpoint: string | null;
  readonly secret: SecretValue | null;
}
export interface ProviderAdapter {
  readonly id: string;
  test(input: AdapterTestInput): Promise<AdapterTestReport>;
}

/** Deterministic fake: answers every probe, lists one model per listing probe, costs nothing. Records what it received. */
export class FakeProviderAdapter implements ProviderAdapter {
  readonly received: AdapterTestInput[] = [];
  constructor(readonly id = 'fake', private readonly outcome: AdapterTestReport['outcome'] = 'ok') {}
  async test(input: AdapterTestInput): Promise<AdapterTestReport> {
    this.received.push(input);
    return { outcome: this.outcome, latencyMs: 1, modelsListed: input.probes.filter((p) => p.kind === 'list_models').length, costMinorUnits: this.outcome === 'ok' ? '0' : null };
  }
}

/** `manual` mode: a person performs the operation and records evidence; the test confirms the configuration only. */
export class ManualProviderAdapter implements ProviderAdapter {
  readonly id = 'manual';
  async test(): Promise<AdapterTestReport> {
    return { outcome: 'ok', latencyMs: null, modelsListed: null, costMinorUnits: null };
  }
}

export type AdapterResolution = { adapter: ProviderAdapter; reason: null } | { adapter: null; reason: 'adapter_unavailable' };

/** The adapters of this process: the built-in fake and manual adapters, plus whatever LLM-001 and others register. */
export class ProviderAdapterRegistry {
  private readonly live = new Map<string, ProviderAdapter>();
  readonly fake: ProviderAdapter;
  readonly manual: ProviderAdapter = new ManualProviderAdapter();
  constructor(fake: ProviderAdapter = new FakeProviderAdapter()) {
    this.fake = fake;
  }
  /** Registers a live adapter by its adapter id (engine code with a fake; never configured from chat or a request). */
  register(adapter: ProviderAdapter): void {
    if (!/^[a-z][a-z0-9_]{1,40}$/.test(adapter.id) || adapter.id === 'fake') throw new Error(`invalid adapter id ${adapter.id}`);
    this.live.set(adapter.id, adapter);
  }
  resolve(adapterId: string, mode: 'fake' | 'manual' | 'live'): AdapterResolution {
    if (mode === 'fake') return { adapter: this.fake, reason: null };
    if (mode === 'manual') return { adapter: this.manual, reason: null };
    const adapter = this.live.get(adapterId);
    return adapter ? { adapter, reason: null } : { adapter: null, reason: 'adapter_unavailable' };
  }
}
