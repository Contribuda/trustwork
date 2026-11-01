import type { z } from 'zod';
import { PrivacyRegistryBatchSchema, type PrivacyRegistryEntrySchema } from '../../../../../../packages/contracts/src/privacy.js';

export interface PrivacyRegistryPort {
  readonly kind: 'fake_drop';
  read(): Promise<{ status: 'available'; entries: z.infer<typeof PrivacyRegistryEntrySchema>[] } | { status: 'unavailable' }>;
}

/** Explicit synthetic intake. No network or provider credentials; registry entries are never proof of identity. */
export class FakeDropRegistry implements PrivacyRegistryPort {
  readonly kind = 'fake_drop' as const;
  constructor(private readonly entries: unknown, private readonly available = true) {}
  async read(): ReturnType<PrivacyRegistryPort['read']> {
    return this.available ? { status: 'available', entries: PrivacyRegistryBatchSchema.parse(this.entries) } : { status: 'unavailable' };
  }
}
