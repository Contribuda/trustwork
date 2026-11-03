import type { ExtensionCallInput } from '../../../../packages/contracts/src/agent-extensions.js';

/**
 * Adapters of the governed extension registry (AGT-023). An adapter is code installed with the engine: a manifest names one
 * and its fake, it never supplies code. Whatever an adapter returns is untrusted data until `ExtensionCallOutputSchema` has
 * read it, and even then it is data: nothing it says reaches the runtime as a command.
 *
 * No live adapter ships. A live adapter is an owner-approved integration; `live: null` means the extension runs only where
 * its route resolves to a fake connection, and is refused anywhere else.
 */
export interface ExtensionAdapterCall {
  operation: string;
  /** Stable across attempts: a repeated call with the same key is the same effect. */
  correlationKey: string;
  input: ExtensionCallInput;
}
export type ExtensionAdapterLookup = { found: false } | { found: true; output: unknown };

export interface ExtensionAdapter {
  readonly id: string;
  readonly mode: 'fake' | 'live';
  /** The raw adapter result: untrusted, unparsed. */
  call(request: ExtensionAdapterCall, signal: AbortSignal): Promise<unknown>;
  /** Lookup only, never a second effect; reconciliation of an unknown outcome depends on it. */
  lookup(correlationKey: string): Promise<ExtensionAdapterLookup>;
}

export interface InstalledExtensionAdapter {
  adapterId: string;
  fakeAdapterId: string;
  fake: ExtensionAdapter;
  live: ExtensionAdapter | null;
}

/** Deterministic fake: answers from a script, keeps one effect per correlation key and records what it received. */
export class FakeExtensionAdapter implements ExtensionAdapter {
  readonly mode = 'fake' as const;
  readonly calls: ExtensionAdapterCall[] = [];
  private readonly effects = new Map<string, unknown>();

  constructor(readonly id: string, private readonly answer: (request: ExtensionAdapterCall) => unknown = (r) => ({ summary: `Synthetic result of ${r.operation}`, facts: { status: 'ok' } })) {}

  async call(request: ExtensionAdapterCall): Promise<unknown> {
    this.calls.push(request);
    if (!this.effects.has(request.correlationKey)) this.effects.set(request.correlationKey, this.answer(request));
    return this.effects.get(request.correlationKey);
  }

  async lookup(correlationKey: string): Promise<ExtensionAdapterLookup> {
    return this.effects.has(correlationKey) ? { found: true, output: this.effects.get(correlationKey) } : { found: false };
  }
}

/** What the engine installs: one synthetic adapter pair for tests and dry runs. */
export const ENGINE_EXTENSION_ADAPTERS: readonly InstalledExtensionAdapter[] = [
  { adapterId: 'synthetic_http', fakeAdapterId: 'synthetic_http_fake', fake: new FakeExtensionAdapter('synthetic_http_fake'), live: null },
];

/** The installed pair a manifest names; both ids must match, so a manifest cannot pair a real adapter with another fake. */
export function installedAdapter(adapters: readonly InstalledExtensionAdapter[], adapter: { adapterId: string; fakeAdapterId: string }): InstalledExtensionAdapter | null {
  return adapters.find((a) => a.adapterId === adapter.adapterId && a.fakeAdapterId === adapter.fakeAdapterId) ?? null;
}
