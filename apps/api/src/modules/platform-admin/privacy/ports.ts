import type { Readable } from 'node:stream';
import type { Principal } from '../../../deps/contracts.js';
import type { Transaction } from '../../../deps/data.js';
import type { RequestState } from '../../../common/request.js';
import type { PrivacySubject } from '../../../../../../packages/contracts/src/privacy.js';

/** The composition root supplies existing owner-module serializers under the requesting principal. */
export interface PrivacyExportPort {
  readonly coverage: readonly { module: string; status: 'supported' | 'partial' | 'unsupported'; includes: string }[];
  file(trx: Transaction, principal: Principal, state: RequestState, subject: PrivacySubject, id: string,
    consume: (file: { stream: Readable; bytes: number; sha256: string }) => Promise<void>): Promise<void>;
  compose(trx: Transaction, principal: Principal, state: RequestState, subject: PrivacySubject): Promise<Record<string, unknown>>;
}
