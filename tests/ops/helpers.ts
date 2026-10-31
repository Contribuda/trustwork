import type { DataPool } from '@trustwork/data';

/** Synthetic secrets planted in requests and errors; none of them may appear in any log line. */
export const PLANTED = {
  password: 'correct horse battery staple 42',
  dbPassword: 'hunter2-db-password',
  email: 'anna@example.invalid',
  sessionToken: 'S'.repeat(43),
  bearer: 'eyJhbGciOiJIUzI1NiJ9.planted.signature',
  apiToken: 'tok_0123456789abcdef',
  budget: '987654321',
};

/** A pool whose every call fails with an error that echoes a connection string, an e-mail and a token. */
export function failingPool(onCall: () => void = () => undefined): DataPool {
  const boom = async (): Promise<never> => {
    onCall();
    throw Object.assign(new Error(`connect failed for postgresql://app:${PLANTED.dbPassword}@db.internal/trustwork as ${PLANTED.email} token=${PLANTED.apiToken}`), { code: 'ECONNREFUSED' });
  };
  const pool = { query: boom, connect: boom, end: async () => undefined, on: () => pool, totalCount: 0, idleCount: 0, waitingCount: 0 };
  return pool as unknown as DataPool;
}

/** Collects structured log lines and parses them. */
export class LogCapture {
  readonly lines: string[] = [];
  readonly sink = (line: string): void => {
    this.lines.push(line);
  };
  records(): Record<string, unknown>[] {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  forRequest(requestId: string): Record<string, unknown>[] {
    return this.lines.filter((line) => line.includes(requestId)).map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

export const SAME_ORIGIN = { 'x-trustwork-request': '1', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
