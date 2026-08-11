import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSnapshot, fetchWorldMeta } from './api';

/**
 * Both polled routes must send a validator.
 *
 * `/world` emitted an ETag from the day it shipped, the server never compared it, and the client
 * never sent one — so the material catalogue, which is ~88% of that response and grows with the
 * world's chemistry, was re-serialised and re-downloaded on every poll. Two halves of one fix: the
 * server honours `if-none-match` (pinned in `apps/world-web/src/api.test.ts`) and the client sends
 * it (pinned here). Either half alone is inert, which is why both are tested.
 */

interface FetchCall {
  readonly url: string;
  readonly ifNoneMatch: string | undefined;
}

function stubFetch(responses: readonly { status: number; etag?: string; body?: unknown }[]): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let index = 0;
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), ifNoneMatch: headers['If-None-Match'] });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const responseHeaders = new Headers();
    if (next?.etag !== undefined) responseHeaders.set('ETag', next.etag);
    return Promise.resolve({
      ok: next!.status >= 200 && next!.status < 300,
      status: next!.status,
      headers: responseHeaders,
      json: () => Promise.resolve(next?.body ?? {}),
    } as unknown as Response);
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('conditional fetches', () => {
  it('sends no validator on the first world-meta fetch and records the returned one', async () => {
    const { calls } = stubFetch([{ status: 200, etag: '"w1"', body: { worldId: 'w' } }]);
    const first = await fetchWorldMeta();
    expect(calls[0]?.url).toContain('/world');
    expect(calls[0]?.ifNoneMatch).toBeUndefined();
    expect(first.etag).toBe('"w1"');
    expect(first.unchanged).toBe(false);
  });

  it('sends the validator on a subsequent world-meta fetch and reuses the value on 304', async () => {
    const previous = { worldId: 'w' } as never;
    const { calls } = stubFetch([{ status: 304 }]);
    const result = await fetchWorldMeta({ etag: '"w1"', previous });
    expect(calls[0]?.ifNoneMatch).toBe('"w1"');
    expect(result.unchanged).toBe(true);
    // Identity, not equality: the caller stores this in a ref and feeds it to React, which bails
    // out of re-rendering only when the reference is unchanged.
    expect(result.value).toBe(previous);
    expect(result.etag).toBe('"w1"');
  });

  it('does not send a validator it cannot act on', async () => {
    // Without `previous` a 304 has nothing to return, so sending the validator would turn an
    // unchanged world into an error rather than a saving.
    const { calls } = stubFetch([{ status: 200, etag: '"w2"', body: { worldId: 'w' } }]);
    await fetchWorldMeta({ etag: '"w1"' });
    expect(calls[0]?.ifNoneMatch).toBeUndefined();
  });

  it('still sends a validator for snapshots', async () => {
    const previous = { tick: 1 } as never;
    const { calls } = stubFetch([{ status: 304 }]);
    const result = await fetchSnapshot({ etag: '"s1"', previous });
    expect(calls[0]?.ifNoneMatch).toBe('"s1"');
    expect(result.unchanged).toBe(true);
  });
});
