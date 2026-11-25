/**
 * Structured logging.
 *
 * Deliberately dependency-free. pino is the usual choice, but its transports
 * use worker threads that need extra configuration to survive Next's bundling,
 * and this app is a single local process writing newline-delimited JSON to
 * stdout. The tradeoff is no log rotation and no transport ecosystem; if either
 * is ever needed, swap this module for pino behind the same interface.
 *
 * Secret hygiene: `redact` strips PAT-shaped values from anything logged,
 * because git and ADO errors sometimes echo URLs or headers back to us.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const minLevel: LogLevel =
  (process.env.LOG_LEVEL as LogLevel | undefined) ??
  (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

export type LogFields = Record<string, unknown>;

/**
 * Azure DevOps PATs are long base32-ish strings. Also catch Basic auth headers
 * and credentials embedded in URLs.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b[A-Za-z0-9]{52,}\b/g,
  /(Authorization:\s*(?:Basic|Bearer)\s+)\S+/gi,
  /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
];

export function redact(value: string): string {
  let out = value;
  out = out.replace(SECRET_PATTERNS[0], '[redacted]');
  out = out.replace(SECRET_PATTERNS[1], '$1[redacted]');
  out = out.replace(SECRET_PATTERNS[2], '$1[redacted]@');
  return out;
}

function redactDeep(input: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth limit]';
  if (typeof input === 'string') return redact(input);
  if (input instanceof Error) {
    return { name: input.name, message: redact(input.message), stack: input.stack ? redact(input.stack) : undefined };
  }
  if (Array.isArray(input)) return input.map((item) => redactDeep(item, depth + 1));
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input)) out[key] = redactDeep(val, depth + 1);
    return out;
  }
  return input;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derive a logger that stamps every entry with additional context. */
  child(bindings: LogFields): Logger;
}

function write(level: LogLevel, scope: string, bindings: LogFields, message: string, fields?: LogFields): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: redact(message),
    ...(redactDeep({ ...bindings, ...fields }) as LogFields),
  };

  const line = JSON.stringify(entry);
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export function createLogger(scope: string, bindings: LogFields = {}): Logger {
  return {
    debug: (message, fields) => write('debug', scope, bindings, message, fields),
    info: (message, fields) => write('info', scope, bindings, message, fields),
    warn: (message, fields) => write('warn', scope, bindings, message, fields),
    error: (message, fields) => write('error', scope, bindings, message, fields),
    child: (extra) => createLogger(scope, { ...bindings, ...extra }),
  };
}

export const logger = createLogger('app');
