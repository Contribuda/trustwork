import type { FastifyReply, FastifyRequest } from 'fastify';
import { FLOW_COOKIE, SESSION_COOKIE } from '../deps/contracts.js';
import type { ApiConfig } from '../config.js';

/**
 * `__Host-` cookies: Secure, Path=/, no Domain. Chrome and Firefox accept them on http://localhost; for other plain
 * HTTP development hosts `API_INSECURE_COOKIES=1` drops both the prefix and the Secure flag (never in production).
 */
export function sessionCookieName(config: ApiConfig): string {
  return config.cookies.hostPrefix ? SESSION_COOKIE : SESSION_COOKIE.replace('__Host-', '');
}
export function flowCookieName(config: ApiConfig): string {
  return config.cookies.hostPrefix ? FLOW_COOKIE : FLOW_COOKIE.replace('__Host-', '');
}

function base(config: ApiConfig, maxAgeSeconds: number) {
  return { path: '/', httpOnly: true, secure: config.cookies.secure, sameSite: 'lax' as const, maxAge: maxAgeSeconds };
}
export function setSessionCookie(reply: FastifyReply, config: ApiConfig, token: string): void {
  reply.setCookie(sessionCookieName(config), token, base(config, Math.floor(config.session.absoluteMs / 1000)));
}
export function clearSessionCookie(reply: FastifyReply, config: ApiConfig): void {
  reply.clearCookie(sessionCookieName(config), { path: '/', httpOnly: true, secure: config.cookies.secure, sameSite: 'lax' });
}
export function setFlowCookie(reply: FastifyReply, config: ApiConfig, value: string, maxAgeSeconds: number): void {
  reply.setCookie(flowCookieName(config), value, base(config, maxAgeSeconds));
}
export function clearFlowCookie(reply: FastifyReply, config: ApiConfig): void {
  reply.clearCookie(flowCookieName(config), { path: '/', httpOnly: true, secure: config.cookies.secure, sameSite: 'lax' });
}
export function readCookie(request: FastifyRequest, name: string): string | null {
  const cookies = (request as FastifyRequest & { cookies?: Record<string, string | undefined> }).cookies;
  const value = cookies?.[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
