import type { StoredWorldEvent } from '@autocosm/domain';

/**
 * Newest-first paging over the append-only event log.
 *
 * Both adapters share this walk, because they had silently disagreed about what "newest first"
 * means and only one of them was ever tested.
 *
 * The in-memory adapter could sort its whole map and then paginate, which is correct at any size.
 * Table Storage cannot: it scans ascending by `(PartitionKey, RowKey)`, offers no `ORDER BY`, and
 * has no way to ask for the last rows of a range. Fetching one page and sorting *that page*
 * descending produces output that is convincingly ordered — ticks really do descend — while
 * containing the oldest rows in the table. A deployed world at tick 3346 served its timeline from
 * ticks 1-16 for exactly this reason.
 *
 * So instead of sorting a page, this walks backwards from the present in bounded tick windows. A
 * window is small enough to read whole, which is what makes "the newest N" answerable at all.
 */

/**
 * Row keys pad the tick to 12 digits, so this is the largest tick the key space can express and
 * therefore the safe default upper bound when a caller does not know the world's current tick.
 */
export const MAX_EVENT_TICK = 999_999_999_999;

/** Ticks in the first window. Sized to cover a page at ordinary event density in one read. */
const INITIAL_WINDOW_TICKS = 64;

/** A quiet stretch of history widens the window rather than paying a round trip per 64 ticks. */
const MAX_WINDOW_TICKS = 4096;

/** Bounds the walk so a sparse or empty range cannot spin. */
const MAX_WINDOWS = 12;

/**
 * Rows a single-tick read may return before the walk gives up narrowing.
 *
 * Narrowing bottoms out at one tick, which cannot be split further, so that final read is allowed a
 * far larger cap. Measured density is ~12.5 events/tick, so this carries roughly three orders of
 * magnitude of headroom; beyond it the page would come from the older end of that one tick.
 */
const SINGLE_TICK_CAP = 10_000;

/**
 * A page position. The tick alone is not enough: a single tick emits many events, so a page can
 * end mid-tick and the next page must resume *within* that tick rather than skipping the rest of
 * it or repeating it.
 */
export interface EventCursor {
  readonly tick: number;
  readonly id: string;
}

/**
 * Newest first, and within a tick by descending id so the order is total and stable. Ids are
 * deterministic, so two events in the same tick always sort the same way in every process.
 */
export function compareEventsNewestFirst(a: StoredWorldEvent, b: StoredWorldEvent): number {
  if (a.tick !== b.tick) return b.tick - a.tick;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** True when `event` sorts strictly after `cursor`, i.e. it belongs on a later page. */
function isAfterCursor(event: StoredWorldEvent, cursor: EventCursor): boolean {
  if (event.tick !== cursor.tick) return event.tick < cursor.tick;
  return event.id < cursor.id;
}

export function encodeEventCursor(cursor: EventCursor): string {
  return Buffer.from(`${String(cursor.tick)}~${cursor.id}`, 'utf8').toString('base64url');
}

/**
 * Decode a page position. A malformed cursor is treated as absent rather than fatal: a stale or
 * hand-edited value should restart the timeline at the present, not fail the request.
 */
export function decodeEventCursor(raw: string | undefined): EventCursor | undefined {
  if (raw === undefined || raw === '') return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  const separator = decoded.indexOf('~');
  if (separator <= 0) return undefined;
  const tick = Number.parseInt(decoded.slice(0, separator), 10);
  const id = decoded.slice(separator + 1);
  if (!Number.isSafeInteger(tick) || tick < 0 || id === '') return undefined;
  return { tick, id };
}

/**
 * Read every event in an inclusive tick range, or report that the range holds more than `cap`.
 *
 * Reporting rather than truncating matters: a truncated read returns the *oldest* rows of the
 * window, which is the very failure this module exists to prevent. The walk narrows the window
 * instead.
 */
export interface EventWindowFetch {
  (
    lowTick: number,
    highTick: number,
    cap: number,
  ): Promise<{ readonly rows: readonly StoredWorldEvent[]; readonly complete: boolean }>;
}

export interface EventPageOptions {
  readonly limit: number;
  /** Inclusive upper bound of the walk — normally the world's current tick. */
  readonly startTick: number;
  /** Inclusive lower bound. The walk stops below this. */
  readonly floorTick: number;
  readonly cursor?: EventCursor | undefined;
  readonly fetch: EventWindowFetch;
  /** Applied after fetching, for predicates the underlying store cannot express as a key range. */
  readonly accept?: ((event: StoredWorldEvent) => boolean) | undefined;
}

export interface EventPage {
  readonly items: readonly StoredWorldEvent[];
  readonly continuation?: string;
}

/**
 * Walk backwards from `startTick` collecting at least `limit` events, newest first.
 *
 * The walk stops as soon as it has a full page, so an active world costs exactly one window read.
 */
export async function pageEventsNewestFirst(options: EventPageOptions): Promise<EventPage> {
  const { limit, floorTick, cursor, fetch, accept } = options;
  if (limit <= 0) return { items: [] };

  const collected: StoredWorldEvent[] = [];
  // Resuming mid-tick means re-reading that tick and discarding what the previous page returned.
  let high = Math.min(options.startTick, cursor?.tick ?? options.startTick);
  let width = INITIAL_WINDOW_TICKS;
  let windows = 0;
  let exhausted = true;

  while (collected.length < limit && high >= floorTick) {
    if (windows >= MAX_WINDOWS) {
      exhausted = false;
      break;
    }
    const low = Math.max(floorTick, high - width + 1);
    const cap = low === high ? SINGLE_TICK_CAP : Math.max(limit * 4, 512);
    const window = await fetch(low, high, cap);

    if (!window.complete && low < high) {
      // Too dense to read whole. Narrowing keeps the newest end of the range reachable; accepting
      // a truncated read would hand back the oldest rows of the window.
      width = Math.max(1, Math.floor((high - low + 1) / 4));
      continue;
    }

    for (const event of window.rows) {
      if (cursor !== undefined && !isAfterCursor(event, cursor)) continue;
      if (accept !== undefined && !accept(event)) continue;
      collected.push(event);
    }

    high = low - 1;
    width = Math.min(width * 4, MAX_WINDOW_TICKS);
    windows += 1;
  }

  collected.sort(compareEventsNewestFirst);
  const items = collected.slice(0, limit);
  const last = items[items.length - 1];

  // More may remain either because the page filled early or because the walk was cut short.
  const more = collected.length > items.length || !exhausted;
  if (!more || last === undefined) return { items };
  return { items, continuation: encodeEventCursor({ tick: last.tick, id: last.id }) };
}
