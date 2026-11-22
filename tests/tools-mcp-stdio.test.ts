import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext, ToolDefinition } from "../server/tools";
import { loadMcpTools, mcpServerFrom, type McpServerConfig } from "../server/tools/mcp";
import { childEnvironment, closeStdioConnections, stdioConnection } from "../server/tools/mcp-stdio";
import {
  buildServerTools,
  installServerTools,
  serverToolProblems,
  serverTools,
  setServerToolsForTests
} from "../server/tools/registry";

const FIXTURE = path.resolve("tests/fixtures/mcp-stdio-server.mjs");
const context: ToolContext = { sessionId: "s1", callId: "c1", signal: new AbortController().signal };

function entry(extra: Record<string, unknown> = {}, flags: string[] = []): McpServerConfig {
  const { server, problem } = mcpServerFrom({
    name: "local",
    command: process.execPath,
    args: [FIXTURE, ...flags],
    ...extra
  });
  if (!server) throw new Error(problem);
  return server;
}

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const opened: Array<() => void> = [];
async function load(server: McpServerConfig, options: Parameters<typeof loadMcpTools>[1] = {}) {
  const loaded = await loadMcpTools(server, options);
  opened.push(loaded.close);
  const tool = (name: string): ToolDefinition => {
    const found = loaded.tools.find((one) => one.name === name);
    if (!found) throw new Error(`no tool ${name}: ${loaded.problems.join("; ")}`);
    return found;
  };
  return { ...loaded, tool };
}

afterEach(() => {
  opened.splice(0).forEach((close) => close());
  closeStdioConnections();
});

describe("an MCP server named by a command", () => {
  it("is read from the config with its arguments, environment and directory", () => {
    expect(
      mcpServerFrom({
        name: "files",
        command: " npx ",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/docs"],
        env: { API_KEY: "${CRM_KEY}" },
        cwd: "/srv",
        allowedTools: ["read_file"],
        prefix: "fs"
      }).server
    ).toEqual({
      name: "files",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/docs"],
      env: { API_KEY: "${CRM_KEY}" },
      cwd: "/srv",
      allowedTools: ["read_file"],
      prefix: "fs",
      timeoutMs: 15_000
    });
    expect(mcpServerFrom({ name: "files", command: "mcp-files" }).server).toEqual({
      name: "files",
      command: "mcp-files",
      args: [],
      env: {},
      timeoutMs: 15_000
    });
  });

  it("says what is wrong with an entry", () => {
    const problem = (raw: Record<string, unknown>) => mcpServerFrom({ name: "files", ...raw }).problem;
    expect(problem({})).toBe("mcp server files: needs a url, or a command to run");
    expect(problem({ command: "x", url: "https://mcp.example.com" })).toBe(
      "mcp server files: takes a url or a command, not both"
    );
    expect(problem({ command: "x", headers: { a: "b" } })).toBe(
      "mcp server files: headers go with a url, not with a command"
    );
    expect(problem({ command: "  " })).toBe("mcp server files: command must be the program to run");
    expect(problem({ command: ["npx", "x"] })).toBe("mcp server files: command must be the program to run");
    expect(problem({ command: "x", args: "-y" })).toBe("mcp server files: args must be a list of at most 64 texts");
    expect(problem({ command: "x", args: ["-y", 5] })).toBe(
      "mcp server files: args must be a list of at most 64 texts"
    );
    expect(problem({ command: "x", env: { "BAD NAME": "1" } })).toBe("mcp server files: invalid env variable BAD NAME");
    expect(problem({ command: "x", env: { A: 1 } })).toBe("mcp server files: invalid env variable A");
    expect(problem({ command: "x", cwd: 5 })).toBe("mcp server files: cwd must be a directory");
    expect(problem({ url: "https://mcp.example.com", args: ["x"] })).toBe(
      "mcp server files: args goes with a command, not with a url"
    );
  });

  it("starts the program, introduces itself and lists the tools", async () => {
    const logged: string[] = [];
    const { tools, problems, tool } = await load(entry({ allowedTools: ["echo", "env"], prefix: "local" }), {
      onLog: (line) => logged.push(line)
    });
    expect(problems).toEqual([]);
    expect(tools.map((one) => one.name)).toEqual(["local_echo", "local_env"]);
    expect(await tool("local_echo").handler({ text: "hello" }, context)).toBe("echo: hello");
    // What the program writes to stderr is its log.
    expect(logged).toContain("fixture ready");
  });

  it("gives the program a small environment: what a program needs, what the config names, and no more", async () => {
    const env = {
      PATH: process.env.PATH,
      HOME: "/home/relay",
      OPENAI_API_KEY: "sk-relay-secret",
      RELAY_AUTH_TOKEN: "relay-token",
      CRM_KEY: "crm-123"
    };
    const { tool } = await load(entry({ env: { API_KEY: "${CRM_KEY}", MODE: "test" } }), { env });
    const seen = (await tool("env").handler({}, context)) as Record<string, string>;
    expect(seen.API_KEY).toBe("crm-123");
    expect(seen.MODE).toBe("test");
    expect(seen.HOME).toBe("/home/relay");
    expect(seen.PATH).toBe(process.env.PATH);
    // The relay's own keys are not the tool server's business.
    expect(seen.OPENAI_API_KEY).toBeUndefined();
    expect(seen.RELAY_AUTH_TOKEN).toBeUndefined();
    expect(seen.CRM_KEY).toBeUndefined();
    expect(childEnvironment({ Path: "C:\\\\bin", SECRET: "x" }, { A: "1" })).toEqual({ Path: "C:\\\\bin", A: "1" });
  });

  it("does not start a program whose environment names a variable the relay does not have", async () => {
    const starts = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-")), "starts");
    const { tools, problems } = await load(entry({ env: { API_KEY: "${CRM_KEY}", MCP_FIXTURE_STARTS: starts } }), {
      env: { PATH: process.env.PATH }
    });
    expect(tools).toEqual([]);
    expect(problems).toEqual(["local MCP server is not available: relay is missing environment variable CRM_KEY"]);
    expect(fs.existsSync(starts)).toBe(false);
  });

  it("starts the program in the directory the config names", async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-")));
    const { tool } = await load(entry({ cwd: directory }));
    expect(await tool("where").handler({}, context)).toBe(directory);
  });

  it("reads past a line that is no message, answers a ping and refuses what it does not offer", async () => {
    const logged: string[] = [];
    const { tool } = await load(entry({}, ["--chatty"]), { onLog: (line) => logged.push(line) });
    expect(logged).toContain("starting up, please wait");
    expect(JSON.parse((await tool("ask").handler({}, context)) as string)).toEqual({ ping: {}, sampling: -32601 });
  });

  it("gives a problem and no tools for a command that is not there, exits at once or refuses", async () => {
    const missing = await load(entry({ command: "/nonexistent/mcp-server-of-nobody", args: [] }));
    expect(missing.tools).toEqual([]);
    expect(missing.problems).toEqual(["local MCP server is not available: the local MCP server could not be started"]);
    const gone = await load(entry({}, ["--exit-at-once"]));
    expect(gone.tools).toEqual([]);
    expect(gone.problems[0]).toMatch(/^local MCP server is not available: the local MCP server (stopped|could not)/);
    const refused = await load(entry({}, ["--refuse"]));
    expect(refused.problems).toEqual(["local MCP server is not available: not today"]);
    // The path of the program is the owner's business and does not travel in a problem.
    expect(JSON.stringify([missing.problems, gone.problems])).not.toContain("nonexistent");
  });

  it("gives up on a call that takes too long, and tells the server so", async () => {
    // The same time is what the program gets to start and introduce itself, so it is not a short one.
    const { tool } = await load(entry({ timeoutMs: 2000 }));
    await expect(tool("slow").handler({ ms: 30_000 }, context)).rejects.toThrow(
      "the local MCP server did not answer within 2 s"
    );
    // The server heard that the request was given up, and is still there for the next one.
    const cancelled = JSON.parse((await tool("cancelled").handler({}, context)) as string) as number[];
    expect(cancelled).toHaveLength(1);
  });

  it("gives up on a call when the conversation cancels it", async () => {
    const { tool } = await load(entry());
    const abort = new AbortController();
    const call = tool("slow").handler({ ms: 5000 }, { ...context, signal: abort.signal });
    setTimeout(() => abort.abort(), 50);
    await expect(call).rejects.toThrow("call to the local MCP server was cancelled");
    expect(JSON.parse((await tool("cancelled").handler({}, context)) as string)).toHaveLength(1);
  });

  it("fails the call that was under way when the program stopped, and starts it again for a later one", async () => {
    const starts = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-")), "starts");
    let time = 0;
    const { tool } = await load(entry({ env: { MCP_FIXTURE_STARTS: starts } }), { now: () => time });
    await expect(tool("crash").handler({}, context)).rejects.toThrow("the local MCP server stopped before it answered");
    // At once: not started again yet, so that a program that keeps falling over is not started in a loop.
    await expect(tool("echo").handler({ text: "a" }, context)).rejects.toThrow("the local MCP server is not running");
    time += 5000;
    // Later: started again, and introduced to again before the call.
    expect(await tool("echo").handler({ text: "b" }, context)).toBe("echo: b");
    expect(fs.readFileSync(starts, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("reads an answer the program wrote just before it went", async () => {
    const { tool } = await load(entry());
    expect(await tool("last_words").handler({}, context)).toBe("w".repeat(8000));
  });

  it("keeps no program running for a server none of whose tools can be used", async () => {
    const starts = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-")), "starts");
    const { tools } = await load(entry({ allowedTools: ["no_such_tool"], env: { MCP_FIXTURE_STARTS: starts } }));
    expect(tools).toEqual([]);
    const pid = Number(fs.readFileSync(starts, "utf8").trim());
    await expect.poll(() => running(pid), { timeout: 5000 }).toBe(false);
  });

  it("leaves nothing running when it is stopped while the program is starting", async () => {
    const starts = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-")), "starts");
    const connection = stdioConnection("local MCP server", () => ({
      command: process.execPath,
      args: [FIXTURE],
      env: { MCP_FIXTURE_STARTS: starts }
    }));
    const started = connection.start();
    connection.close();
    await expect(started).rejects.toThrow("the local MCP server was stopped");
    // It may have got as far as writing its pid down, or not: either way it is not there afterwards.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const pid = fs.existsSync(starts) ? Number(fs.readFileSync(starts, "utf8").trim()) : undefined;
    if (pid !== undefined) await expect.poll(() => running(pid), { timeout: 5000 }).toBe(false);
  });

  it("stops a program that sends a line too long to be a message", async () => {
    const { tool } = await load(entry());
    await expect(tool("big").handler({}, context)).rejects.toThrow(
      "the local MCP server sent a message that is too long"
    );
  });

  it("stops the program when the tools are closed, and calls fail from then on", async () => {
    const starts = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-")), "starts");
    const { tool, close } = await load(entry({ env: { MCP_FIXTURE_STARTS: starts } }));
    const pid = Number(fs.readFileSync(starts, "utf8").trim());
    expect(() => process.kill(pid, 0)).not.toThrow();
    close();
    await expect(tool("echo").handler({ text: "a" }, context)).rejects.toThrow("the local MCP server was stopped");
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return "running";
        } catch {
          return "gone";
        }
      })
      .toBe("gone");
  });
});

describe("the relay's tools, with an MCP server it runs itself", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const pids = (file: string) => fs.readFileSync(file, "utf8").trim().split("\n").map(Number);

  afterEach(() => setServerToolsForTests());

  it("starts the program with the tools, and ends it when the tools are replaced", async () => {
    const starts = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-")), "starts");
    const source = {
      mcpServers: [
        {
          name: "local",
          command: process.execPath,
          args: [FIXTURE],
          env: { MCP_FIXTURE_STARTS: starts },
          allowedTools: ["echo"]
        }
      ]
    };
    await installServerTools(source);
    expect(serverToolProblems()).toEqual([]);
    expect(serverTools().map((tool) => tool.name)).toEqual(["echo"]);
    const [first] = pids(starts);
    expect(alive(first!)).toBe(true);
    // The tools are installed again: the first program must not be left behind.
    await installServerTools(source);
    const [, second] = pids(starts);
    expect(second).toBeDefined();
    expect(alive(second!)).toBe(true);
    await expect.poll(() => alive(first!)).toBe(false);
    expect(await serverTools()[0]!.handler({ text: "again" }, context)).toBe("echo: again");
    // A config without the server ends its program.
    await installServerTools({});
    await expect.poll(() => alive(second!)).toBe(false);
    expect(serverTools()).toEqual([]);
  });

  it("does not start a program over and over whose tools cannot be used", async () => {
    const built = await buildServerTools({
      mcpServers: [
        {
          name: "local",
          command: process.execPath,
          args: [FIXTURE],
          allowedTools: ["no_such_tool"],
          backgroundTools: ["no_such_tool"]
        }
      ]
    });
    opened.push(built.close);
    expect(built.tools).toEqual([]);
    expect(built.problems.join("; ")).toContain("backgroundTools names no_such_tool, which the server does not have");
    // It answered: trying again would start the program again, to the same end.
    expect(built.unreachable).toEqual([]);
  });

  it("leaves no program running for a server that could not be used", async () => {
    const starts = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-")), "starts");
    await installServerTools({
      mcpServers: [
        { name: "local", command: process.execPath, args: [FIXTURE, "--refuse"], env: { MCP_FIXTURE_STARTS: starts } }
      ]
    });
    expect(serverTools()).toEqual([]);
    expect(serverToolProblems()).toEqual(["local MCP server is not available: not today"]);
    const [pid] = pids(starts);
    await expect.poll(() => alive(pid!)).toBe(false);
  });
});
