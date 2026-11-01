import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { receivePaymentSource } from './source-adapter.js';
import { receivePaymentWebhook, type PaymentRuntime } from './index.js';

/** Bounded raw-byte ingress. Deployment owns TLS/routing; an empty provider registry refuses every sender. */
export async function startPaymentIngress(runtime: PaymentRuntime, port: number) {
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
    } catch {
      // Provider/body/database details are private; failure never acknowledges settlement.
      response.writeHead(400).end();
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())) };
}
