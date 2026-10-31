import type { ApiConfig } from '../../config.js';
import type { AdmissionGate, DataPool } from '../../deps/data.js';
import type { Clock, MailPort, MandateRevocationPort, OidcProviderPort, StaffRoleResolver } from './ports.js';

/** Everything the identity and projects modules depend on; tests substitute fakes and clocks. */
export interface AppContext {
  config: ApiConfig;
  pool: DataPool;
  clock: Clock;
  mail: MailPort;
  providers: Record<'google' | 'apple', OidcProviderPort | null>;
  mandates: MandateRevocationPort;
  staffRoles: StaffRoleResolver;
  admission: AdmissionGate;
  log: (message: string, error?: unknown) => void;
}
export const APP_CONTEXT = Symbol('trustwork.app-context');
