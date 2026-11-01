import { createHash, randomBytes } from 'node:crypto';

/** A new setup token: 32 random bytes, base64url without padding (`SetupTokenSchema`). Printed once; never stored. */
export function newSetupToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores and compares: the lowercase hex SHA-256 of the token's UTF-8 bytes. */
export function setupTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
