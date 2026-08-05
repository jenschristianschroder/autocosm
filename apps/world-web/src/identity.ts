import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Creator identity.
 *
 * This is deliberately weak and deliberately explicit: an anonymous, browser-scoped identifier
 * signed by the server so it cannot be forged to impersonate another creator or to escape a
 * quota. It is *not* an account, it proves nothing about a person, and anyone who copies the
 * cookie inherits it. The interface exists so a real identity provider (Entra External ID) can be
 * substituted without touching route code.
 */

export const CREATOR_COOKIE = 'autocosm_creator';
/** Cookie lifetime. Long enough to keep a creator's agents attributed across sessions. */
export const CREATOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

export interface CreatorToken {
  readonly creatorId: string;
  readonly cookieValue: string;
}

export interface CreatorIdentity {
  /** Resolve an existing signed token, or mint a new one. */
  resolve(cookieValue: string | undefined): CreatorToken;
  readonly kind: 'anonymous-browser';
}

const ID_BYTES = 12;

export class SignedCookieCreatorIdentity implements CreatorIdentity {
  readonly kind = 'anonymous-browser';
  readonly #key: string;
  readonly #newId: () => string;

  constructor(signingKey: string, newId: () => string = defaultId) {
    if (signingKey.length < 16) {
      throw new Error('creator signing key must be at least 16 characters');
    }
    this.#key = signingKey;
    this.#newId = newId;
  }

  resolve(cookieValue: string | undefined): CreatorToken {
    if (cookieValue !== undefined) {
      const existing = this.#verify(cookieValue);
      if (existing !== undefined) return { creatorId: existing, cookieValue };
    }
    const creatorId = this.#newId();
    return { creatorId, cookieValue: `${creatorId}.${this.#sign(creatorId)}` };
  }

  #sign(creatorId: string): string {
    return createHmac('sha256', this.#key).update(creatorId).digest('base64url');
  }

  #verify(value: string): string | undefined {
    const separator = value.lastIndexOf('.');
    if (separator <= 0) return undefined;
    const creatorId = value.slice(0, separator);
    const signature = value.slice(separator + 1);
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(creatorId)) return undefined;

    const expected = Buffer.from(this.#sign(creatorId));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length) return undefined;
    return timingSafeEqual(expected, actual) ? creatorId : undefined;
  }
}

function defaultId(): string {
  return `cr-${randomBytes(ID_BYTES).toString('base64url')}`;
}

/** Generate a signing key for local development so the app runs with no configuration. */
export function ephemeralSigningKey(): string {
  return randomBytes(32).toString('base64url');
}
