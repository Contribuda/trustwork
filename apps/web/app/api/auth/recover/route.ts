import { NextResponse } from 'next/server';
import { errorEnvelope } from '@trustwork/contracts/client';
import { fakeAuth } from '@/app/_lib/auth-fake';
import { primeLocale } from '@/app/_lib/locale';

/**
 * Fake auth route (WEB-001): contract-shaped validation and error envelopes only; no session is issued.
 * Mutations must carry the contract header `X-Trustwork-Request` (ADR 002 amendment); BE-001 adds the
 * Sec-Fetch-Site/Origin checks when the real `/v1/auth/*` proxy replaces this handler.
 */
export async function POST(request: Request): Promise<NextResponse> {
  await primeLocale();
  const headers = { 'cache-control': 'no-store' };
  if (request.headers.get('x-trustwork-request') !== '1') return NextResponse.json(errorEnvelope('auth.csrf_rejected', 'web-fake-csrf'), { status: 403, headers });
  const payload = await request.json().catch(() => null);
  const { status, body } = fakeAuth.recoverRequest(payload);
  return NextResponse.json(body, { status, headers });
}
