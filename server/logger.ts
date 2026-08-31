// Lightweight structured logging for the relay. Every line carries an ISO
// timestamp, a level, and a scope (usually the short session id) so a single
// grep can reconstruct one session's life cycle out of interleaved output.

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// LOG_LEVEL=debug surfaces per-event noise (frame types, status pushes);
// the default "info" keeps one line per meaningful transition. Resolved once at
// module load: the relay reads it at startup and nothing reloads env mid-session,
// so re-parsing process.env on every log line is wasted work.
const configuredLevel = (): LogLevel => {
  const value = process.env.LOG_LEVEL?.trim().toLowerCase();
  return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "info";
};
const ACTIVE_LEVEL = configuredLevel();

function write(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>) {
  if (LEVEL_RANK[level] < LEVEL_RANK[ACTIVE_LEVEL]) return;
  const suffix = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : "";
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${suffix}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export type Logger = {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

/** A logger whose lines are tagged with `scope` (e.g. `sess:ab12cd34`). */
export function createLogger(scope: string): Logger {
  return {
    debug: (message, fields) => write("debug", scope, message, fields),
    info: (message, fields) => write("info", scope, message, fields),
    warn: (message, fields) => write("warn", scope, message, fields),
    error: (message, fields) => write("error", scope, message, fields)
  };
}

/** Short id used to tag all log lines of one relay connection. */
export function shortSessionId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}
