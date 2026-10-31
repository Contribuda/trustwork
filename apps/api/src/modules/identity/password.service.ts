import { hash, verify } from '@node-rs/argon2';
import type { ApiConfig } from '../../config.js';

/**
 * Argon2id (PHC string) through @node-rs/argon2: OWASP m=19456 KiB, t=2, p=1 by default, parametrised by config.
 * Input is the NFC-normalised password (the contract schema normalises before the hash sees it); `needsRehash`
 * compares the stored PHC parameters with the current policy so hashes are upgraded on successful login.
 */
export class PasswordService {
  constructor(private readonly config: ApiConfig['password']) {}

  hash(password: string): Promise<string> {
    return hash(password.normalize('NFC'), { memoryCost: this.config.memoryCost, timeCost: this.config.timeCost, parallelism: this.config.parallelism, outputLen: 32 });
  }

  /** Uniform work: always verifies, including the deterministic dummy hash for unknown accounts. */
  async verify(phc: string, password: string): Promise<boolean> {
    try {
      return await verify(phc, password.normalize('NFC'));
    } catch {
      return false;
    }
  }

  needsRehash(phc: string): boolean {
    const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(phc);
    if (!match) return true;
    return Number(match[1]) !== this.config.memoryCost || Number(match[2]) !== this.config.timeCost || Number(match[3]) !== this.config.parallelism;
  }
}
