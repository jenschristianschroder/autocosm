import { describe, expect, it } from 'vitest';
import { Logger, REDACTED, memorySink, sanitise, type LogRecord } from './logger.js';
import { Metrics } from './metrics.js';
import { correlationIdFrom, sequentialIdFactory } from './correlation.js';

describe('sanitise', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = sanitise({
      safe: 'ok',
      apiKey: 'abc',
      nested: { connectionString: 'x', deeper: { Token: 'y' } },
    }) as Record<string, unknown>;
    expect(out['safe']).toBe('ok');
    expect(out['apiKey']).toBe(REDACTED);
    const nested = out['nested'] as Record<string, unknown>;
    expect(nested['connectionString']).toBe(REDACTED);
    expect((nested['deeper'] as Record<string, unknown>)['Token']).toBe(REDACTED);
  });

  it('redacts secret-shaped values even under an innocent key', () => {
    const out = sanitise({
      detail:
        'DefaultEndpointsProtocol=https;AccountName=a;AccountKey=Zm9vYmFy;EndpointSuffix=core.windows.net',
      note: 'https://x.table.core.windows.net/?sig=AAAAAAAAAAAAAAAAAAAAAA%3D',
      auth: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9aaaa',
    }) as Record<string, unknown>;
    expect(out['detail']).toBe(REDACTED);
    expect(out['note']).toBe(REDACTED);
    expect(out['auth']).toBe(REDACTED);
  });

  it('bounds strings, arrays and depth', () => {
    const long = 'x'.repeat(2000);
    expect(String(sanitise(long)).length).toBeLessThan(600);

    const big = Array.from({ length: 100 }, (_, i) => i);
    const arr = sanitise(big) as unknown[];
    expect(arr.length).toBe(33);
    expect(arr[32]).toBe('…68 more');

    let deep: Record<string, unknown> = { end: 'value' };
    for (let i = 0; i < 12; i += 1) deep = { down: deep };
    expect(JSON.stringify(sanitise(deep))).toContain('[truncated]');
  });

  it('never throws on hostile input', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    // Cycles terminate at the depth limit rather than overflowing the stack.
    expect(() => JSON.stringify(sanitise(cyclic))).not.toThrow();
    expect(sanitise(() => 1)).toBe('[unloggable]');
    expect(sanitise(Symbol('s'))).toBe('[unloggable]');
    expect(sanitise(Number.NaN)).toBe('NaN');
  });

  it('summarises errors without leaking a whole stack', () => {
    const out = sanitise(new Error('boom')) as Record<string, unknown>;
    expect(out['name']).toBe('Error');
    expect(out['message']).toBe('boom');
    expect(String(out['stack']).split('\n').length).toBeLessThanOrEqual(8);
  });
});

describe('Logger', () => {
  const fixedNow = (): Date => new Date('2024-01-01T00:00:00.000Z');

  it('writes one structured record per call', () => {
    const store: LogRecord[] = [];
    const log = new Logger({ sink: memorySink(store), now: fixedNow, context: { mode: 'tick' } });
    log.info('advanced', { tickId: 7 });
    expect(store).toHaveLength(1);
    const record = store[0];
    expect(record).toBeDefined();
    if (!record) return;
    expect(record.level).toBe('info');
    expect(record.message).toBe('advanced');
    expect(record.context.mode).toBe('tick');
    expect(record.data).toEqual({ tickId: 7 });
    expect(record.timestamp).toBe('2024-01-01T00:00:00.000Z');
  });

  it('respects the level threshold', () => {
    const store: LogRecord[] = [];
    const log = new Logger({ sink: memorySink(store), level: 'warn' });
    log.debug('no');
    log.info('no');
    log.warn('yes');
    log.error('yes');
    expect(store.map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('merges child context without mutating the parent', () => {
    const store: LogRecord[] = [];
    const parent = new Logger({ sink: memorySink(store), context: { worldId: 'w1' } });
    const child = parent.child({ tick: 5 });
    child.info('child');
    parent.info('parent');
    expect(store[0]?.context).toEqual({ worldId: 'w1', tick: 5 });
    expect(store[1]?.context).toEqual({ worldId: 'w1' });
  });

  it('redacts data passed to the logger', () => {
    const store: LogRecord[] = [];
    new Logger({ sink: memorySink(store) }).info('call', { prompt: 'secret words', model: 'gpt' });
    expect(store[0]?.data).toEqual({ prompt: REDACTED, model: 'gpt' });
  });

  it('bounds the retained buffer of a memory sink', () => {
    const store: LogRecord[] = [];
    const log = new Logger({ sink: memorySink(store, 10) });
    for (let i = 0; i < 50; i += 1) log.info(`m${i}`);
    expect(store).toHaveLength(10);
    expect(store[9]?.message).toBe('m49');
  });
});

describe('Metrics', () => {
  it('accumulates counters, gauges and durations', () => {
    const m = new Metrics();
    m.increment('tick.executed');
    m.increment('tick.executed', 2);
    m.gauge('tick.lag', 4);
    m.gauge('tick.lag', 9);
    m.observeDuration('tick.durationMs', 10);
    m.observeDuration('tick.durationMs', 30);

    const snap = m.snapshot();
    expect(snap.counters['tick.executed']).toBe(3);
    expect(snap.gauges['tick.lag']).toBe(9);
    expect(snap.durations['tick.durationMs']).toEqual({
      count: 2,
      totalMs: 40,
      maxMs: 30,
      meanMs: 20,
    });
  });

  it('records a duration even when the timed operation throws', async () => {
    const m = new Metrics();
    await expect(m.time('api.durationMs', () => Promise.reject(new Error('nope')))).rejects.toThrow(
      'nope',
    );
    expect(m.snapshot().durations['api.durationMs']?.count).toBe(1);
  });

  it('flushes as a single log line and resets', () => {
    const store: LogRecord[] = [];
    const m = new Metrics();
    m.increment('model.calls');
    m.flush(new Logger({ sink: memorySink(store) }));
    expect(store).toHaveLength(1);
    expect(store[0]?.message).toBe('metrics');
    m.reset();
    expect(m.snapshot().counters).toEqual({});
  });
});

describe('correlation ids', () => {
  it('adopts a well-formed inbound id', () => {
    expect(correlationIdFrom('req-123_abc')).toBe('req-123_abc');
  });

  it('mints a fresh id for missing or hostile values', () => {
    const factory = sequentialIdFactory('c');
    expect(correlationIdFrom(undefined, factory)).toBe('c-000001');
    expect(correlationIdFrom('bad value with spaces', factory)).toBe('c-000002');
    expect(correlationIdFrom('inject\nnewline', factory)).toBe('c-000003');
    expect(correlationIdFrom('x'.repeat(200), factory)).toBe('c-000004');
    expect(correlationIdFrom(42, factory)).toBe('c-000005');
  });
});
