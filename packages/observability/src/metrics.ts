/**
 * Counters and duration samples.
 *
 * The MVP has no metrics backend, so measurement is log-derived: a process accumulates counters
 * in memory and flushes them as one structured line. That is enough to answer the operational
 * questions in `docs/operations.md` (tick lag, rejected proposals, storage conflicts, snapshot
 * size) without adding a fixed-cost dependency.
 */
import type { Logger } from './logger.js';

/** The closed set of measurements the system reports. A typo cannot invent a new series. */
export const COUNTERS = [
  'tick.executed',
  'tick.skipped',
  'tick.catchupRemaining',
  'tick.lag',
  'tick.durationMs',
  'tick.eventsWritten',
  'organisms.active',
  'organisms.born',
  'organisms.died',
  'decisions.pending',
  'decisions.claimed',
  'decisions.expired',
  'decisions.applied',
  'decisions.rejected',
  'model.calls',
  'model.failures',
  'model.promptTokens',
  'model.completionTokens',
  'proposals.invalid',
  'storage.conflicts',
  'storage.requests',
  'storage.retries',
  'api.requests',
  'api.errors',
  'api.rateLimited',
  'api.durationMs',
  'api.snapshotBytes',
  'api.serverErrors',
  'api.notModified',
  'api.agentsCreated',
  'api.goalsSubmitted',
  'world.loads',
] as const;

export type CounterName = (typeof COUNTERS)[number];

export interface MetricSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly gauges: Readonly<Record<string, number>>;
  readonly durations: Readonly<Record<string, DurationSummary>>;
}

export interface DurationSummary {
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

interface DurationAccumulator {
  count: number;
  totalMs: number;
  maxMs: number;
}

export class Metrics {
  readonly #counters = new Map<string, number>();
  readonly #gauges = new Map<string, number>();
  readonly #durations = new Map<string, DurationAccumulator>();

  increment(name: CounterName, by = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  /** Record an absolute value such as a queue depth or lag, replacing the previous reading. */
  gauge(name: CounterName, value: number): void {
    this.#gauges.set(name, value);
  }

  observeDuration(name: CounterName, ms: number): void {
    const existing = this.#durations.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
    existing.count += 1;
    existing.totalMs += ms;
    existing.maxMs = Math.max(existing.maxMs, ms);
    this.#durations.set(name, existing);
  }

  /** Time an operation and record its duration whether or not it throws. */
  async time<T>(name: CounterName, operation: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await operation();
    } finally {
      this.observeDuration(name, Math.round(performance.now() - started));
    }
  }

  snapshot(): MetricSnapshot {
    const durations: Record<string, DurationSummary> = {};
    for (const [name, acc] of this.#durations) {
      durations[name] = {
        count: acc.count,
        totalMs: acc.totalMs,
        maxMs: acc.maxMs,
        meanMs: acc.count === 0 ? 0 : Math.round(acc.totalMs / acc.count),
      };
    }
    return {
      counters: Object.fromEntries([...this.#counters].sort(([a], [b]) => (a < b ? -1 : 1))),
      gauges: Object.fromEntries([...this.#gauges].sort(([a], [b]) => (a < b ? -1 : 1))),
      durations,
    };
  }

  reset(): void {
    this.#counters.clear();
    this.#gauges.clear();
    this.#durations.clear();
  }

  /** Emit the whole snapshot as one structured log line. Jobs call this just before exiting. */
  flush(logger: Logger, message = 'metrics'): void {
    logger.info(message, { metrics: this.snapshot() });
  }
}
