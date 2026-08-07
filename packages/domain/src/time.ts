import { type TickIndex, clamp, toInt } from './units.js';

/**
 * Logical time.
 *
 * Inside the simulation, time is an integer tick index. Wall-clock instants only appear at
 * I/O boundaries and are always UTC ISO-8601 strings.
 */

/** An ISO-8601 UTC timestamp such as `2026-01-01T00:00:00.000Z`. */
export type IsoInstant = string;

/** Port supplying wall-clock time to infrastructure code. Never used inside a tick. */
export interface Clock {
  nowIso(): IsoInstant;
  nowEpochMs(): number;
}

/** A clock frozen at a fixed instant, used by tests. */
export class FixedClock implements Clock {
  #epochMs: number;

  constructor(startIso: IsoInstant) {
    this.#epochMs = Date.parse(startIso);
    if (Number.isNaN(this.#epochMs)) {
      throw new RangeError(`FixedClock requires a valid ISO instant, received ${startIso}`);
    }
  }

  nowIso(): IsoInstant {
    return new Date(this.#epochMs).toISOString();
  }

  nowEpochMs(): number {
    return this.#epochMs;
  }

  /** Advance the frozen clock. Tests use this to exercise lease and claim expiry. */
  advanceMs(deltaMs: number): void {
    this.#epochMs += toInt(deltaMs);
  }
}

/** Calendar shape of a world: how many ticks make up a day and a season. */
export interface WorldCalendar {
  /** Logical ticks in one full day/night cycle. */
  readonly ticksPerDay: number;
  /** Logical ticks between scheduled environmental pressure events. */
  readonly ticksPerPressureCycle: number;
  /** Simulated minutes represented by a single tick. Presentation only. */
  readonly simulatedMinutesPerTick: number;
}

export const DEFAULT_CALENDAR: WorldCalendar = {
  ticksPerDay: 96,
  ticksPerPressureCycle: 480,
  simulatedMinutesPerTick: 15,
};

/** Position within the day/night cycle, in per-mille of a full day. */
export function dayPhasePerMille(tick: TickIndex, calendar: WorldCalendar): number {
  const period = Math.max(1, toInt(calendar.ticksPerDay));
  const phase = ((toInt(tick) % period) + period) % period;
  return Math.trunc((phase * 1000) / period);
}

/**
 * Ambient light for a tick, in per-mille.
 *
 * A triangular curve is used rather than a sine so that the value is exactly reproducible
 * with integer arithmetic. Night is not fully dark: a floor of 60‰ models starlight.
 */
export function ambientLightPerMille(tick: TickIndex, calendar: WorldCalendar): number {
  const phase = dayPhasePerMille(tick, calendar);
  const daylight = phase < 500 ? phase * 2 : (1000 - phase) * 2;
  return Math.trunc(clamp(60 + (daylight * 940) / 1000, 0, 1000));
}

/** Named stretch of the day, derived from the day phase so a reading and its name cannot disagree. */
export type DayPhaseName = 'night' | 'dawn' | 'morning' | 'midday' | 'afternoon' | 'dusk';

export interface DayPhaseDescription {
  /** Minutes since midnight, 0..1439. */
  readonly minuteOfDay: number;
  /** 24-hour reading such as `06:15`. */
  readonly clock: string;
  readonly name: DayPhaseName;
}

/** Day number a tick falls in, counting from the world's first day. */
export function dayOfTick(tick: TickIndex, calendar: WorldCalendar): number {
  const period = Math.max(1, toInt(calendar.ticksPerDay));
  return Math.floor(Math.max(0, toInt(tick)) / period);
}

/**
 * Render a day phase as a clock reading.
 *
 * Takes the phase rather than the tick on purpose: the phase is authoritative and travels in the
 * snapshot, so a caller displaying it can never drift from the daylight the simulation actually
 * used. Phase 0 is midnight and phase 500 is noon, matching the light curve above.
 */
export function describeDayPhase(dayPhasePerMille: number): DayPhaseDescription {
  const phase = clamp(toInt(dayPhasePerMille), 0, 1000);
  const minuteOfDay = Math.min(1439, Math.trunc((phase * 1440) / 1000));
  const hour = Math.trunc(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return {
    minuteOfDay,
    clock: `${pad2(hour)}:${pad2(minute)}`,
    name: dayPhaseName(hour),
  };
}

function dayPhaseName(hour: number): DayPhaseName {
  if (hour < 4) return 'night';
  if (hour < 7) return 'dawn';
  if (hour < 11) return 'morning';
  if (hour < 13) return 'midday';
  if (hour < 17) return 'afternoon';
  if (hour < 20) return 'dusk';
  return 'night';
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Index of the pressure cycle a tick belongs to. Used to schedule environmental events. */
export function pressureCycleIndex(tick: TickIndex, calendar: WorldCalendar): number {
  const period = Math.max(1, toInt(calendar.ticksPerPressureCycle));
  return Math.floor(toInt(tick) / period);
}

/** True when a tick begins a new environmental pressure cycle. */
export function isPressureBoundary(tick: TickIndex, calendar: WorldCalendar): boolean {
  const period = Math.max(1, toInt(calendar.ticksPerPressureCycle));
  return toInt(tick) > 0 && toInt(tick) % period === 0;
}

/**
 * Storage epoch for a tick.
 *
 * Epochs bucket append-only rows so no Table partition grows without bound.
 */
export const TICKS_PER_EPOCH = 1000;

export function epochOfTick(tick: TickIndex): number {
  return Math.floor(Math.max(0, toInt(tick)) / TICKS_PER_EPOCH);
}

/** Zero-padded tick string used for lexicographic row-key ordering. */
export function tickKey(tick: TickIndex): string {
  return String(Math.max(0, toInt(tick))).padStart(12, '0');
}
