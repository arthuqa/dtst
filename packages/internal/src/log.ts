/**
 * stderr-only structured logging.
 *
 * MCP stdio transports own stdout for JSON-RPC, so a single stray
 * `console.log` corrupts the protocol stream. Everything in @dtst therefore
 * logs through this module, which always writes to stderr.
 */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const secrets = new Set<string>();

/** Register a secret so it can never reach a log line or an error message. */
export function registerSecret(secret: string | undefined): void {
  if (!secret) return;
  const trimmed = secret.trim();
  // Ignore trivially short values: replacing them would mangle unrelated text.
  if (trimmed.length < 8) return;
  secrets.add(trimmed);
}

/** Remove every registered secret from a string. */
export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.split(secret).join("«redacted»");
  }
  return out;
}

let level: LogLevel = resolveLogLevel(process.env);

export function normalizeLevel(value: string | undefined): LogLevel {
  const candidate = (value ?? "").trim().toLowerCase();
  return candidate in LEVEL_ORDER ? (candidate as LogLevel) : "warn";
}

/**
 * Resolve the log level from the environment.
 *
 *   DTST_LOG_LEVEL=silent|error|warn|info|debug   (explicit, wins)
 *   DEBUG=true                                    (idiomatic shorthand for debug)
 */
export function resolveLogLevel(env: Record<string, string | undefined> = process.env): LogLevel {
  const explicit = env["DTST_LOG_LEVEL"];
  if (explicit !== undefined && explicit.trim() !== "") return normalizeLevel(explicit);
  const debug = (env["DEBUG"] ?? "").trim().toLowerCase();
  if (debug !== "" && !["0", "false", "no", "off"].includes(debug)) return "debug";
  return "warn";
}

/** Set the level explicitly; `undefined` re-derives it from the environment. */
export function setLogLevel(next?: LogLevel | string | undefined): void {
  level = next === undefined ? resolveLogLevel(process.env) : normalizeLevel(next);
}

export function getLogLevel(): LogLevel {
  return level;
}

function enabled(target: LogLevel): boolean {
  return LEVEL_ORDER[target] <= LEVEL_ORDER[level] && level !== "silent";
}

function emit(target: Exclude<LogLevel, "silent">, message: string, fields?: Record<string, unknown>): void {
  if (!enabled(target)) return;
  const parts = [`[dtst] ${target} ${redact(message)}`];
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      parts.push(`${key}=${formatValue(value)}`);
    }
  }
  try {
    process.stderr.write(`${parts.join(" ")}\n`);
  } catch {
    // A broken stderr must never take the server down.
  }
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return redact(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  if (value instanceof Error) return redact(value.message);
  try {
    return redact(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

export interface Logger {
  error(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  child(prefix: string): Logger;
}

export function createLogger(prefix?: string): Logger {
  const withPrefix = (message: string): string => (prefix ? `${prefix}: ${message}` : message);
  return {
    error: (message, fields) => emit("error", withPrefix(message), fields),
    warn: (message, fields) => emit("warn", withPrefix(message), fields),
    info: (message, fields) => emit("info", withPrefix(message), fields),
    debug: (message, fields) => emit("debug", withPrefix(message), fields),
    child: (childPrefix) => createLogger(prefix ? `${prefix}:${childPrefix}` : childPrefix),
  };
}

export const logger = createLogger();

/**
 * Time a section of work and log the duration at debug level.
 * Never rethrows: the wrapped function's errors propagate untouched.
 */
export async function timed<T>(label: string, fn: () => Promise<T>, log: Logger = logger): Promise<T> {
  const started = Date.now();
  try {
    const value = await fn();
    log.debug(`${label} ok`, { ms: Date.now() - started });
    return value;
  } catch (error) {
    log.debug(`${label} failed`, { ms: Date.now() - started, error });
    throw error;
  }
}
