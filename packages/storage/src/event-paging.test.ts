import type { StoredWorldEvent } from '@autocosm/domain';
import { describe, expect, it } from 'vitest';
import {
  compareEventsNewestFirst,
  decodeEventCursor,
  encodeEventCursor,
  pageEventsNewestFirst,
} from './event-paging.js';

/**
 * The walk that both adapters share.
 *
 * The contract suite can only reach the in-memory adapter, so the Azure ordering was never tested
 * by anything and a deployed world served its timeline from ticks 1-16 while sitting at tick 3346.
 * These tests stand in for that gap: the fake below reproduces the two properties of Table Storage
 * that caused the bug — scans run *ascending*, and a range read is capped — without needing an
 * account or Azurite.
 */

function event(id: string, tick: number): StoredWorldEvent {
  return {
    rv: 1,
    id,
    worldId: 'world-alpha',
    tick,
    regionId: 'r0x0',
    kind: 'organismFed',
    summary: `event ${id}`,
    emittedAtEpochMs: 0,
  } as StoredWorldEvent;
}

/** Ascending by (tick, id), exactly as a table scan would return it. */
function ascendingLog(count: number, startTick = 1): StoredWorldEvent[] {
  return Array.from({ length: count }, (_, i) =>
    event(`e-${String(i).padStart(4, '0')}`, startTick + i),
  );
}

function fetcherFor(log: readonly StoredWorldEvent[]) {
  const calls: { low: number; high: number }[] = [];
  const fetch = async (low: number, high: number, cap: number) => {
    calls.push({ low, high });
    const rows = log
      .filter((e) => e.tick >= low && e.tick <= high)
      .sort((a, b) => a.tick - b.tick || (a.id < b.id ? -1 : 1));
    // A capped scan yields the *oldest* rows of the range, which is the trap being guarded against.
    return rows.length > cap
      ? { rows: rows.slice(0, cap), complete: false }
      : { rows, complete: true };
  };
  return { fetch, calls };
}

describe('newest-first event paging', () => {
  it('returns the newest events from a log far longer than a page', async () => {
    const log = ascendingLog(5000);
    const { fetch } = fetcherFor(log);

    const page = await pageEventsNewestFirst({ limit: 20, startTick: 5000, floorTick: 0, fetch });

    expect(page.items.map((e) => e.tick)).toEqual(Array.from({ length: 20 }, (_, i) => 5000 - i));
  });

  it('reads one window when the world is active', async () => {
    const log = ascendingLog(5000);
    const { fetch, calls } = fetcherFor(log);

    await pageEventsNewestFirst({ limit: 20, startTick: 5000, floorTick: 0, fetch });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.high).toBe(5000);
  });

  it('widens the window across a quiet stretch of history rather than giving up', async () => {
    // One event, then two thousand silent ticks. A fixed 64-tick window would never reach it.
    const log = [event('e-old', 10)];
    const { fetch, calls } = fetcherFor(log);

    const page = await pageEventsNewestFirst({ limit: 20, startTick: 2000, floorTick: 0, fetch });

    expect(page.items.map((e) => e.id)).toEqual(['e-old']);
    expect(calls.length).toBeGreaterThan(1);
  });

  it('narrows rather than accepting a truncated read of a dense window', async () => {
    // Two dense ticks 60 apart: the opening 64-tick window holds 1200 rows against a cap of 512, so
    // accepting the capped read would hand back the oldest rows and reproduce the original bug.
    const log = [
      ...Array.from({ length: 400 }, (_, i) => event(`e-a-${String(i).padStart(3, '0')}`, 950)),
      ...Array.from({ length: 800 }, (_, i) => event(`e-b-${String(i).padStart(3, '0')}`, 1000)),
    ];
    const { fetch, calls } = fetcherFor(log);

    const page = await pageEventsNewestFirst({ limit: 20, startTick: 1000, floorTick: 0, fetch });

    expect(page.items).toHaveLength(20);
    expect(page.items.every((e) => e.tick === 1000)).toBe(true);
    expect(page.items[0]?.id).toBe('e-b-799');
    // It got there by narrowing, not by widening or by taking the first read as given.
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[calls.length - 1]?.low).toBeGreaterThan(calls[0]?.low ?? 0);
  });

  it('reads a single hyper-dense tick whole once narrowing can go no further', async () => {
    // 3000 events in one tick. Narrowing bottoms out at low === high, so that last read must be
    // allowed a cap large enough to see the newest rows.
    const log = Array.from({ length: 3000 }, (_, i) =>
      event(`e-${String(i).padStart(4, '0')}`, 1000),
    );
    const { fetch } = fetcherFor(log);

    const page = await pageEventsNewestFirst({ limit: 10, startTick: 1000, floorTick: 0, fetch });

    expect(page.items[0]?.id).toBe('e-2999');
  });

  it('pages backwards without repeating or skipping an event', async () => {
    const log = ascendingLog(300);
    const { fetch } = fetcherFor(log);

    const seen: string[] = [];
    let cursor = undefined as string | undefined;
    for (let i = 0; i < 8; i += 1) {
      const page: { items: readonly StoredWorldEvent[]; continuation?: string } =
        await pageEventsNewestFirst({
          limit: 25,
          startTick: 300,
          floorTick: 0,
          fetch,
          cursor: decodeEventCursor(cursor),
        });
      seen.push(...page.items.map((e) => e.id));
      if (page.continuation === undefined) break;
      cursor = page.continuation;
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(200);
    expect(seen[0]).toBe('e-0299');
  });

  it('stops cleanly at the end of history', async () => {
    const log = ascendingLog(10);
    const { fetch } = fetcherFor(log);

    const page = await pageEventsNewestFirst({ limit: 50, startTick: 10, floorTick: 0, fetch });

    expect(page.items).toHaveLength(10);
    expect(page.continuation).toBeUndefined();
  });

  it('honours a floor tick', async () => {
    const log = ascendingLog(100);
    const { fetch } = fetcherFor(log);

    const page = await pageEventsNewestFirst({ limit: 50, startTick: 100, floorTick: 90, fetch });

    expect(page.items.map((e) => e.tick)).toEqual(Array.from({ length: 11 }, (_, i) => 100 - i));
  });

  it('applies a caller predicate the store cannot express as a key range', async () => {
    const log = ascendingLog(200);
    const { fetch } = fetcherFor(log);

    const page = await pageEventsNewestFirst({
      limit: 5,
      startTick: 200,
      floorTick: 0,
      fetch,
      accept: (e) => e.tick % 2 === 0,
    });

    expect(page.items.map((e) => e.tick)).toEqual([200, 198, 196, 194, 192]);
  });

  it('treats a malformed cursor as absent rather than failing the request', () => {
    expect(decodeEventCursor(undefined)).toBeUndefined();
    expect(decodeEventCursor('')).toBeUndefined();
    expect(decodeEventCursor('not-a-cursor')).toBeUndefined();
    expect(decodeEventCursor(encodeEventCursor({ tick: 12, id: 'e-1' }))).toEqual({
      tick: 12,
      id: 'e-1',
    });
  });

  it('orders a tick internally by descending id so the order is total', () => {
    const sorted = [event('e-b', 5), event('e-a', 5), event('e-c', 9)].sort(
      compareEventsNewestFirst,
    );
    expect(sorted.map((e) => e.id)).toEqual(['e-c', 'e-b', 'e-a']);
  });
});
