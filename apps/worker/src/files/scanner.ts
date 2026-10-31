/**
 * Malware scanning port (FILE-001). The scan job calls it on the stored bytes after the content checks. The only adapter
 * shipped is the fake: a hub operator plugs in a real engine (for example a ClamAV daemon on a private network)
 * through this interface; no provider account, no external call by default.
 *
 * Contract: `clean` only when the engine positively cleared the bytes; `infected` with an engine signature name
 * (never file content); a thrown `ScannerUnavailableError` means no verdict (the job retries with backoff).
 */
export type ScanVerdict = { verdict: 'clean' } | { verdict: 'infected'; signature: string };

export interface MalwareScanner {
  readonly name: string;
  scan(bytes: Uint8Array, mediaType: string, signal?: AbortSignal): Promise<ScanVerdict>;
}

export class ScannerUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ScannerUnavailableError';
  }
}

/** The industry-standard antivirus test string (EICAR); harmless, recognised by every engine. */
export const EICAR_TEST_STRING = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * Fake engine: reports the EICAR test string anywhere in the bytes as infected, everything else as clean. Tests can
 * make it unavailable to exercise retries. Counts its calls.
 */
export class FakeMalwareScanner implements MalwareScanner {
  readonly name = 'fake';
  calls = 0;
  unavailable = false;

  async scan(bytes: Uint8Array): Promise<ScanVerdict> {
    this.calls += 1;
    if (this.unavailable) throw new ScannerUnavailableError('fake scanner is unavailable');
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(EICAR_TEST_STRING, 0, 'latin1')
      ? { verdict: 'infected', signature: 'EICAR-Test-File' }
      : { verdict: 'clean' };
  }
}

/**
 * Scanner from the environment: `FILES_SCANNER=fake` (development and tests; refused with NODE_ENV=production). Unset:
 * no scanner (scan jobs wait). Real engines are adapters added by the operator's deployment.
 */
export function scannerFromEnv(env: { NODE_ENV?: string | undefined; FILES_SCANNER?: string | undefined }): MalwareScanner | null {
  const mode = env.FILES_SCANNER?.trim() ?? '';
  if (mode === '') return null;
  if (mode === 'fake') {
    if (env.NODE_ENV === 'production') throw new Error('FILES_SCANNER=fake is a test double and is refused with NODE_ENV=production');
    return new FakeMalwareScanner();
  }
  throw new Error(`FILES_SCANNER must be unset or fake (got ${mode})`);
}
