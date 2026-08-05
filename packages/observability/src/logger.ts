import { z } from 'zod';

/**
 * Fields that identify *where* a log line came from. Every one is optional because a line may
 * be emitted before a world, tick or decision is known, but the set is closed so that a typo
 * cannot silently create a new dimension.
 */
export interface LogContext {
  readonly correlationId?: string;
  readonly worldId?: string;
  readonly tick?: number;
  readonly jobExecutionId?: string;
  readonly decisionId?: string;
  readonly agentId?: string;
  readonly lineageId?: string;
  readonly regionId?: string;
  readonly mode?: string;
  readonly route?: string;
  readonly durationMs?: number;
  readonly outcome?: 'ok' | 'rejected' | 'degraded' | 'error';
}

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

export const LogLevelSchema = z.enum(LOG_LEVELS);

/**
 * Keys whose values are never printed, at any depth.
 *
 * The prompt/reasoning entries matter as much as the credential ones: model prompts may quote
 * an agent's private memories and hidden reasoning is explicitly out of scope for audit.
 */
const REDACTED_KEYS: ReadonlySet<string> = new Set(
  [
    'accountkey',
    'apikey',
    'authorization',
    'connectionstring',
    'cookie',
    'creatortoken',
    'credential',
    'hiddenreasoning',
    'key',
    'password',
    'prompt',
    'promptmessages',
    'reasoning',
    'sas',
    'sastoken',
    'secret',
    'sharedkey',
    'signature',
    'token',
  ].map((k) => k.toLowerCase()),
);

/** Value patterns that must never reach a log sink even under an innocuous key. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /AccountKey\s*=/i,
  /SharedAccessSignature/i,
  /\bsig=[A-Za-z0-9%+/=]{16,}/i,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/i,
  /DefaultEndpointsProtocol=/i,
];

export const REDACTED = '[redacted]';

/** Maximum characters kept from any single string value. Keeps a line bounded. */
const MAX_STRING = 512;

/** Maximum entries kept from any array. Memories and event batches can be long. */
const MAX_ARRAY = 32;

/** Maximum object nesting explored. Deeper values are replaced with a marker. */
const MAX_DEPTH = 6;

export type Loggable = unknown;

/**
 * Make an arbitrary value safe and bounded for structured logging.
 *
 * Redaction is applied by key name *and* by value shape, because a connection string pasted
 * into a field called `detail` is just as dangerous as one called `connectionString`.
 */
export function sanitise(value: Loggable, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[truncated]';

  if (typeof value === 'string') {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(value)) return REDACTED;
    }
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return '[unloggable]';

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitise(value.message, depth + 1),
      // Stacks contain file paths only, never argument values.
      stack:
        typeof value.stack === 'string'
          ? value.stack.split('\n').slice(0, 8).join('\n')
          : undefined,
    };
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) return sanitise(Object.fromEntries(value), depth + 1);
  if (value instanceof Set) return sanitise([...value], depth + 1);

  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY).map((item) => sanitise(item, depth + 1));
    if (value.length > MAX_ARRAY) kept.push(`…${value.length - MAX_ARRAY} more`);
    return kept;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? REDACTED : sanitise(item, depth + 1);
    }
    return out;
  }
  return '[unloggable]';
}

export interface LogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly context: LogContext;
  readonly data?: Record<string, unknown>;
}

/** Where log records go. Swapped for an array in tests. */
export type LogSink = (record: LogRecord) => void;

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly context?: LogContext;
  readonly sink?: LogSink;
  readonly now?: () => Date;
}

/**
 * A structured logger.
 *
 * One line per event, JSON, no interpolation. `child()` narrows context so a request or a tick
 * carries its identifiers without every call site repeating them.
 */
export class Logger {
  readonly #level: LogLevel;
  readonly #context: LogContext;
  readonly #sink: LogSink;
  readonly #now: () => Date;

  constructor(options: LoggerOptions = {}) {
    this.#level = options.level ?? 'info';
    this.#context = options.context ?? {};
    this.#sink = options.sink ?? consoleSink;
    this.#now = options.now ?? ((): Date => new Date());
  }

  child(context: LogContext): Logger {
    return new Logger({
      level: this.#level,
      context: { ...this.#context, ...context },
      sink: this.#sink,
      now: this.#now,
    });
  }

  get context(): LogContext {
    return this.#context;
  }

  debug(message: string, data?: Record<string, Loggable>): void {
    this.#write('debug', message, data);
  }
  info(message: string, data?: Record<string, Loggable>): void {
    this.#write('info', message, data);
  }
  warn(message: string, data?: Record<string, Loggable>): void {
    this.#write('warn', message, data);
  }
  error(message: string, data?: Record<string, Loggable>): void {
    this.#write('error', message, data);
  }

  #write(level: LogLevel, message: string, data?: Record<string, Loggable>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.#level]) return;
    const sanitised = data === undefined ? undefined : (sanitise(data) as Record<string, unknown>);
    this.#sink({
      timestamp: this.#now().toISOString(),
      level,
      message: message.length > MAX_STRING ? `${message.slice(0, MAX_STRING)}…` : message,
      context: this.#context,
      ...(sanitised === undefined ? {} : { data: sanitised }),
    });
  }
}

const consoleSink: LogSink = (record) => {
  const line = JSON.stringify(record);
  if (record.level === 'error' || record.level === 'warn') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
};

/** Collect records in memory. Used by tests and by the readiness endpoint's recent-error buffer. */
export function memorySink(store: LogRecord[], limit = 500): LogSink {
  return (record) => {
    store.push(record);
    if (store.length > limit) store.splice(0, store.length - limit);
  };
}
