import type pg from 'pg';
import { deriveMailSecretKey, mailAddressHash, unsealMailSecret } from '@trustwork/data';

export interface CommittedMail {
  id: string;
  template: string;
  state: string;
  localePreferences: string[];
  /** Template parameters plus the opened one-time token as `token` (tests read links' secrets from here). */
  params: Record<string, string>;
}

/**
 * Reads the mail intents the API committed (mail_delivery rows) through the migrator connection and opens their
 * sealed tokens with the shared key: what the worker would deliver. Rolled-back changes leave nothing here. Rows are
 * matched by the address hash, so they stay countable after the worker cleared the address.
 */
export class CommittedMailbox {
  private readonly key: Buffer;
  constructor(private readonly admin: pg.Pool, secretKey: Buffer) {
    this.key = deriveMailSecretKey(secretKey);
  }

  async to(address: string, template?: string): Promise<CommittedMail[]> {
    const { rows } = await this.admin.query<{ id: string; template: string; state: string; locale_preferences: string[]; params: Record<string, string>; sealed_secret: Buffer | null }>(
      `SELECT id, template, state, locale_preferences, params, sealed_secret FROM trustwork.mail_delivery
       WHERE recipient_hash = $1 AND ($2::text IS NULL OR template = $2) ORDER BY seq`,
      [mailAddressHash(address), template ?? null],
    );
    return rows.map((row) => ({
      id: row.id,
      template: row.template,
      state: row.state,
      localePreferences: row.locale_preferences,
      params: { ...row.params, ...(row.sealed_secret ? { token: unsealMailSecret(this.key, row.id, row.sealed_secret) } : {}) },
    }));
  }

  async lastTo(address: string, template?: string): Promise<CommittedMail | undefined> {
    return (await this.to(address, template)).at(-1);
  }

  async countTo(address: string, template?: string): Promise<number> {
    return (await this.to(address, template)).length;
  }
}
