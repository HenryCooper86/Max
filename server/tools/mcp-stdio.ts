import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * An MCP server run as a process of the relay's own: the "stdio" transport.
 * The relay starts the command the owner wrote in `mcpServers`, and the two
 * speak JSON-RPC 2.0 over the process's stdin and stdout, one message a line.
 * What the process writes to stderr is its log, and goes to the relay's.
 *
 * The process gets a small environment, not the relay's: the relay's
 * environment holds its model keys, and a tool server has no business with
 * them. It gets what a program needs to run (PATH, HOME and the like) and
 * what the owner names for it under `env`.
 *
 * A process that has stopped is started again by the next request, at most
 * once every few seconds. A request that was under way when it stopped fails:
 * what it had done by then is not known, so it is not sent a second time.
 */

/** What a child is given of the relay's own environment. */
const INHERITED = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TZ",
  // Windows
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "TEMP",
  "TMP"
];
/** One message is one line. A line longer than this is not a message, and the process is stopped. */
const MAX_LINE_BYTES = 1024 * 1024;
const MIN_RESTART_INTERVAL_MS = 3_000;
/** How long a process gets to leave after its stdin is closed, before it is killed. */
const EXIT_GRACE_MS = 2_000;
/** How long what a process wrote last may take to be read once it has exited. */
const LAST_WORDS_MS = 1_000;
/** A process that talks without end does not fill the relay's log: this many lines in ten seconds, then one that says so. */
const LOG_LINES_PER_WINDOW = 40;
const LOG_WINDOW_MS = 10_000;
/** A process gets a group of its own where there are such, so that what it started ends with it. */
const OWN_GROUP = process.platform !== "win32";

export type StdioCommand = {
  command: string;
  args: string[];
  /** Added to the small environment the process gets. Already expanded. */
  env: Record<string, string>;
  cwd?: string;
};

export type RpcMessage = { id?: unknown; method?: unknown; result?: unknown; error?: unknown };

/** Why a request got no answer. `gone` when the process could not be started or stopped meanwhile. */
export class StdioError extends Error {
  constructor(
    message: string,
    readonly gone = false
  ) {
    super(message);
  }
}

export type StdioConnection = {
  /** A number that changes each time the process is started: a handshake is good for one of them. */
  generation(): number;
  /** Starts the process when it is not running. Rejects when it cannot be started. */
  start(): Promise<void>;
  /** Sends a request and waits for the response with its id. */
  request(
    message: { id: number; method: string; params?: Record<string, unknown> },
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<RpcMessage>;
  /** Sends a notification. Nothing comes back. */
  notify(message: { method: string; params?: Record<string, unknown> }): void;
  /** Stops the process for good: later requests fail. */
  close(): void;
};

type Waiting = { resolve(message: RpcMessage): void; reject(error: Error): void };

const running = new Set<StdioConnection>();
let exitHooked = false;

/** Stops every MCP process the relay started. For the relay's own exit, and for tests. */
export function closeStdioConnections(): void {
  for (const connection of [...running]) connection.close();
}

export function childEnvironment(own: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(own)) {
    if (value !== undefined && INHERITED.includes(name.toUpperCase())) environment[name] = value;
  }
  return { ...environment, ...extra };
}

export function stdioConnection(
  label: string,
  command: () => StdioCommand,
  options: {
    env?: NodeJS.ProcessEnv;
    /** A line the process wrote to stderr. */
    onLog?: (line: string) => void;
    now?: () => number;
  } = {}
): StdioConnection {
  const now = options.now ?? Date.now;
  let logWindow = -Infinity;
  let logged = 0;
  const onLog = (line: string): void => {
    if (!options.onLog) return;
    if (Date.now() - logWindow > LOG_WINDOW_MS) {
      logWindow = Date.now();
      logged = 0;
    }
    logged += 1;
    if (logged <= LOG_LINES_PER_WINDOW) options.onLog(line);
    else if (logged === LOG_LINES_PER_WINDOW + 1)
      options.onLog("more lines than the relay's log takes: the rest are left out for now");
  };
  let child: ChildProcessWithoutNullStreams | undefined;
  let starting: Promise<void> | undefined;
  let generation = 0;
  let startedAt = -Infinity;
  let closed = false;
  const waiting = new Map<number, Waiting>();

  function failAll(error: Error): void {
    for (const entry of waiting.values()) entry.reject(error);
    waiting.clear();
  }

  function write(message: Record<string, unknown>): void {
    const target = child;
    if (!target || target.stdin.destroyed) throw new StdioError(`the ${label} is not running`, true);
    target.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  }

  function received(line: string): void {
    let message: RpcMessage;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      message = parsed as RpcMessage;
    } catch {
      // Not a message: a server that prints to stdout by mistake. Its log, like stderr.
      onLog(line.slice(0, 500));
      return;
    }
    if (typeof message.method === "string") {
      // The server asks something of the relay. It offers the server nothing but an answer to a ping.
      if (message.id === undefined || message.id === null) return;
      try {
        if (message.method === "ping") write({ id: message.id, result: {} });
        else write({ id: message.id, error: { code: -32601, message: "Method not found" } });
      } catch {
        /* the process is going away */
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    entry.resolve(message);
  }

  function stop(process: ChildProcessWithoutNullStreams): void {
    // Closing stdin is how a stdio server is asked to leave; one that does not is killed.
    process.stdin.end();
    const signal = (name: NodeJS.Signals): void => {
      try {
        // The whole group: a launcher such as npx is not the server, which is a process it started.
        if (OWN_GROUP && process.pid !== undefined) globalThis.process.kill(-process.pid, name);
        else process.kill(name);
      } catch {
        /* it has gone already */
      }
    };
    const timer = setTimeout(() => signal("SIGKILL"), EXIT_GRACE_MS);
    process.once("exit", () => clearTimeout(timer));
    signal("SIGTERM");
  }

  function start(): Promise<void> {
    if (closed) return Promise.reject(new StdioError(`the ${label} was stopped`, true));
    if (child) return Promise.resolve();
    if (starting) return starting;
    if (now() - startedAt < MIN_RESTART_INTERVAL_MS) {
      return Promise.reject(new StdioError(`the ${label} is not running`, true));
    }
    startedAt = now();
    starting = new Promise<void>((resolve, reject) => {
      let spec: StdioCommand;
      try {
        spec = command();
      } catch (error) {
        reject(error instanceof Error ? error : new StdioError(String(error), true));
        return;
      }
      let process: ChildProcessWithoutNullStreams;
      try {
        process = spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          env: childEnvironment(options.env ?? globalThis.process.env, spec.env),
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          detached: OWN_GROUP,
          windowsHide: true
        });
      } catch {
        reject(new StdioError(`the ${label} could not be started`, true));
        return;
      }
      let settled = false;
      let buffer: Buffer = Buffer.alloc(0);
      process.once("spawn", () => {
        settled = true;
        // Stopped while it was starting: nothing is left running that nobody holds.
        if (closed) {
          stop(process);
          reject(new StdioError(`the ${label} was stopped`, true));
          return;
        }
        child = process;
        generation += 1;
        resolve();
      });
      // More than once: a signal that cannot be sent is reported here too, and an event nobody hears ends the relay.
      process.on("error", () => {
        // Before `spawn`: the command is not there or may not be run. After: the process is failing.
        if (!settled) {
          settled = true;
          reject(new StdioError(`the ${label} could not be started`, true));
        }
      });
      // What was waiting fails once all the process wrote has been read: an answer written
      // just before it exited still counts. Not for ever: something it started may hold the pipe open.
      let ended = false;
      const end = (): void => {
        if (ended) return;
        ended = true;
        // Only its own requests: a process started since has its own.
        if (child === undefined || child === process)
          failAll(new StdioError(`the ${label} stopped before it answered`, true));
      };
      process.once("close", end);
      process.once("exit", (code, signal) => {
        if (child === process) child = undefined;
        onLog(`the process ended (${signal ?? `code ${code ?? "unknown"}`})`);
        if (!settled) {
          settled = true;
          reject(new StdioError(`the ${label} could not be started`, true));
        }
        setTimeout(end, LAST_WORDS_MS).unref();
      });
      for (const stream of [process.stdin, process.stdout, process.stderr]) stream.on("error", () => undefined);
      process.stdout.on("data", (chunk: Buffer) => {
        buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
        for (;;) {
          const end = buffer.indexOf(0x0a);
          if (end < 0) break;
          const line = buffer.subarray(0, end).toString("utf8").trim();
          buffer = buffer.subarray(end + 1);
          if (line) received(line);
        }
        if (buffer.length > MAX_LINE_BYTES) {
          buffer = Buffer.alloc(0);
          onLog("a message longer than 1 MB: the process is stopped");
          failAll(new StdioError(`the ${label} sent a message that is too long`, true));
          stop(process);
        }
      });
      let errors = "";
      const decoder = new StringDecoder("utf8");
      process.stderr.on("data", (chunk: Buffer) => {
        errors += decoder.write(chunk);
        for (;;) {
          const end = errors.indexOf("\n");
          if (end < 0) break;
          const line = errors.slice(0, end).trim();
          errors = errors.slice(end + 1);
          if (line) onLog(line.slice(0, 500));
        }
        if (errors.length > 4000) errors = errors.slice(-500);
      });
    }).finally(() => {
      starting = undefined;
    });
    return starting;
  }

  const connection: StdioConnection = {
    generation: () => generation,
    start,
    async request(message, timeoutMs, signal) {
      if (signal?.aborted) throw new StdioError(`call to the ${label} was cancelled`);
      await start();
      // Cancelled while the process was starting: nobody is listening for that any more.
      if (signal?.aborted) throw new StdioError(`call to the ${label} was cancelled`);
      return new Promise<RpcMessage>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", aborted);
        };
        const giveUp = (error: StdioError, reason: string) => {
          if (!waiting.delete(message.id)) return;
          done();
          // The server is told, so that it can stop the work.
          try {
            write({ method: "notifications/cancelled", params: { requestId: message.id, reason } });
          } catch {
            /* it is gone already */
          }
          reject(error);
        };
        const timer = setTimeout(
          () => giveUp(new StdioError(`the ${label} did not answer within ${timeoutMs / 1000} s`), "timed out"),
          timeoutMs
        );
        const aborted = () => giveUp(new StdioError(`call to the ${label} was cancelled`), "cancelled");
        signal?.addEventListener("abort", aborted, { once: true });
        waiting.set(message.id, {
          resolve(answer) {
            done();
            resolve(answer);
          },
          reject(error) {
            done();
            reject(error);
          }
        });
        try {
          write(message);
        } catch (error) {
          waiting.delete(message.id);
          done();
          reject(error instanceof Error ? error : new StdioError(String(error), true));
        }
      });
    },
    notify(message) {
      write(message);
    },
    close() {
      closed = true;
      running.delete(connection);
      const process = child;
      child = undefined;
      failAll(new StdioError(`the ${label} was stopped`, true));
      if (process) stop(process);
    }
  };
  running.add(connection);
  if (!exitHooked) {
    exitHooked = true;
    // A relay that exits takes its tool servers with it.
    process.once("exit", () => {
      for (const one of running) one.close();
    });
  }
  return connection;
}
