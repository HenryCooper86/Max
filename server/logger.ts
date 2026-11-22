// Lightweight structured logging for the relay. Every line carries an ISO
// timestamp, a level, and a scope (usually the short session id) so a single
// grep can reconstruct one session's life cycle out of interleaved output.
// LOG_FORMAT=json writes the same content as one JSON object per line, for log
// collectors that would otherwise have to parse the text layout.

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
const JSON_FORMAT = process.env.LOG_FORMAT?.trim().toLowerCase() === "json";

// The line's own keys. Many call sites pass an upstream error as a field
// called `message`, so a colliding field is renamed rather than dropped.
const RESERVED_KEYS = new Set(["time", "level", "scope", "message"]);

/** JSON.stringify that cannot throw: a log call must never take down the code
 * path it is reporting on, whatever the fields contain. */
function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, field: unknown) => {
      if (typeof field === "bigint") return field.toString();
      if (field instanceof Error) return { name: field.name, message: field.message };
      if (field && typeof field === "object") {
        if (seen.has(field)) return "[circular]";
        seen.add(field);
      }
      return field;
    });
  } catch {
    return JSON.stringify("[unserializable]");
  }
}

function jsonLine(time: string, level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>) {
  const entry: Record<string, unknown> = { time, level, scope, message };
  for (const [key, value] of Object.entries(fields ?? {})) {
    entry[RESERVED_KEYS.has(key) ? `field_${key}` : key] = value;
  }
  return safeJson(entry);
}

function write(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>) {
  if (LEVEL_RANK[level] < LEVEL_RANK[ACTIVE_LEVEL]) return;
  const time = new Date().toISOString();
  const suffix = fields && Object.keys(fields).length ? ` ${safeJson(fields)}` : "";
  const line = JSON_FORMAT
    ? jsonLine(time, level, scope, message, fields)
    : `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${suffix}`;
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
