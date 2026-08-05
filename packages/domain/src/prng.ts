/**
 * Deterministic pseudo-random number generation.
 *
 * `Math.random()` is forbidden everywhere in the domain and simulation packages: a tick
 * must be reproducible from `(state, actions, seed, tick)` alone. Every stochastic decision
 * draws from a `Prng` seeded by a stable hash of its context.
 *
 * The generator is mulberry32. It is small, has a 2^32 period, and uses only `Math.imul`
 * and 32-bit shifts, so it produces bit-identical output on every JavaScript engine.
 */
export class Prng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** Uniform 32-bit unsigned integer. */
  nextUint32(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform integer in `[0, maxExclusive)`. Returns 0 when the range is empty. */
  nextInt(maxExclusive: number): number {
    const bound = Math.trunc(maxExclusive);
    if (bound <= 0) return 0;
    return this.nextUint32() % bound;
  }

  /** Uniform integer in `[min, max]` inclusive. */
  nextRange(min: number, max: number): number {
    const lo = Math.trunc(min);
    const hi = Math.trunc(max);
    if (hi <= lo) return lo;
    return lo + this.nextInt(hi - lo + 1);
  }

  /** True with probability `perMille / 1000`. */
  chance(perMille: number): boolean {
    const p = Math.trunc(perMille);
    if (p <= 0) return false;
    if (p >= 1000) return true;
    return this.nextInt(1000) < p;
  }

  /** Uniform element of a non-empty array, or `undefined` when empty. */
  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[this.nextInt(items.length)];
  }

  /** Fork an independent stream. Used to isolate per-entity draws from iteration order. */
  fork(label: string): Prng {
    return new Prng(hashSeed(label, this.nextUint32()));
  }
}

/**
 * FNV-1a hash over a list of string and number parts.
 *
 * Used to derive stable sub-seeds: `hashSeed(worldSeed, tick, organismId)` gives an
 * organism the same random stream on every replay of that tick.
 */
export function hashSeed(...parts: readonly (string | number)[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    const text = typeof part === 'number' ? `#${Math.trunc(part)}` : part;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x2f;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
