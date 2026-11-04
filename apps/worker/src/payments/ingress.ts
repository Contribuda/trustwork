import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { silentLogger, type Logger } from '../log.js';
import { receivePaymentSource } from './source-adapter.js';
import { receivePaymentWebhook, type PaymentRuntime } from './index.js';

/**
 * The fixed refusals of this path: the worker's own and those of `payments_source_record_assertion`. A message is logged
 * only by being one of these. Nothing else an error carries is safe: a JSON parser quotes the signed body, a schema error
 * quotes its values, and a database error can name a row.
 */
const REASONS: ReadonlySet<string> = new Set([
  'payment source verifier unavailable', 'payment source adapter unavailable', 'source envelope too large', 'invalid source envelope', 'invalid source signature',
  'source registration mismatch', 'source audience mismatch', 'source fact mismatch',
  'payment provider unavailable', 'payment verifier unavailable', 'invalid payment evidence', 'synthetic evidence cannot prove real funds', 'payment sender mismatch', 'payment evidence mode mismatch',
  'source challenge binding mismatch', 'source challenge unavailable', 'source envelope invalid', 'source issuer unavailable', 'source registration contract unavailable', 'source replay conflict',
  'source withdrawal mismatch', 'payment source registration unavailable', 'payment source authority changing', 'identity linkage unavailable', 'independent account identity linkage unavailable',
  'account connection changed', 'account purpose mismatch', 'exact issuer withdrawal required',
]);

/** A reason code for the log: a word from a closed list, or a SQLSTATE. Never text taken from the error. */
export function ingressRefusalReason(error: unknown): string {
  if (!(error instanceof Error)) return 'unclassified';
  if (REASONS.has(error.message)) return error.message.replaceAll(' ', '_');
  if (error instanceof SyntaxError) return 'evidence_not_json';
  if (error.name === 'ZodError') return 'evidence_schema';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `database_${code}` : 'unclassified';
}

/** Bounded raw-byte ingress. Deployment owns TLS/routing; an empty provider registry refuses every sender. */
export async function startPaymentIngress(runtime: PaymentRuntime, port: number, log: Logger = silentLogger) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid payment ingress port');
  const server = createServer(async (request, response) => {
    const match = /^\/payments\/(sources\/)?([a-f0-9-]{36})$/.exec(request.url ?? '');
    const signature = request.headers['payment-signature'];
    if (request.method !== 'POST' || !match || typeof signature !== 'string') {
      response.writeHead(400).end(); return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > 8192) { response.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk as Buffer));
      }
      if (match[1]) {
        if (!runtime.source) throw new Error('payment source verifier unavailable');
        await receivePaymentSource(runtime.source, match[2]!, Buffer.concat(chunks), signature);
      } else await receivePaymentWebhook(runtime, match[2]!, Buffer.concat(chunks), signature);
      response.writeHead(204).end();
    } catch (error) {
      // Provider/body/database details are private; failure never acknowledges settlement. The caller learns nothing;
      // the operator gets the route, the id already in the address and a reason code.
      log('warn', 'payment ingress refused', { route: match[1] ? 'source' : 'webhook', target: match[2], reason: ingressRefusalReason(error) });
      response.writeHead(400).end();
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())) };
}
