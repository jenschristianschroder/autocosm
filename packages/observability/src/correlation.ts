/**
 * Correlation identifiers.
 *
 * Deliberately not `crypto.randomUUID()` at the call site: an id generator is injected so tests
 * are reproducible, and so a request that arrives with an upstream correlation id keeps it.
 */
import { randomUUID } from 'node:crypto';

export type IdFactory = () => string;

export const uuidFactory: IdFactory = () => randomUUID();

/** A monotonic, prefixed id generator for tests. */
export function sequentialIdFactory(prefix = 'id'): IdFactory {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${String(n).padStart(6, '0')}`;
  };
}

const HEADER = 'x-correlation-id';
const SAFE = /^[A-Za-z0-9._:-]{1,128}$/;

export const CORRELATION_HEADER = HEADER;

/**
 * Adopt an inbound correlation id when it is well formed, otherwise mint one.
 *
 * Untrusted header values are never propagated verbatim into logs: an attacker could otherwise
 * inject newlines and forge log records.
 */
export function correlationIdFrom(headerValue: unknown, factory: IdFactory = uuidFactory): string {
  if (typeof headerValue === 'string' && SAFE.test(headerValue)) return headerValue;
  return factory();
}
