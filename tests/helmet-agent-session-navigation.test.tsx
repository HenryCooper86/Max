import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHelmetAgent, type HelmetAgent } from "../src/hooks/useHelmetAgent";
import { MOCK_ROUTE } from "../shared/nav-fixtures";

// Only audio I/O is replaced: the agent hook, navigation controller, relay
// event validation, reconnect handlers, and navigation timers are real.
const audio = vi.hoisted(() => ({
  playPcm16: vi.fn(),
  stopAgentSpeech: vi.fn(),
  speak: vi.fn(),
  speakWarning: vi.fn(),
  ensurePlaybackContext: vi.fn(async () => true),
  closePlayback: vi.fn()
}));
const capture = vi.hoisted(() => ({
  voiceLevel: 0,
  packetStats: {},
  audioProcessing: {},
  setPacketStats: vi.fn(),
  ensureMic: vi.fn(async () => {}),
  releaseMic: vi.fn(),
  setTrackEnabled: vi.fn(),
  resetFrameWindow: vi.fn()
}));
vi.mock("../src/hooks/useAudioPlayback", () => ({ useAudioPlayback: () => audio }));
vi.mock("../src/hooks/useMicCapture", () => ({ useMicCapture: () => capture }));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
type JsonEvent = Record<string, unknown>;
class Socket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
  sent: JsonEvent[] = [];
  constructor() {
    super();
    Socket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = Socket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }
  send(data: string) {
    const event = JSON.parse(data) as JsonEvent;
    this.sent.push(event);
    if (event.type === "session.start")
      queueMicrotask(() =>
        this.receive({
          type: "session.started",
          provider: "mock",
          mode: "mock",
          capabilities: {}
        })
      );
  }
  receive(event: JsonEvent) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  }
  close() {
    this.readyState = Socket.CLOSING;
    queueMicrotask(() => {
      this.readyState = Socket.CLOSED;
      this.dispatchEvent(new Event("close"));
    });
  }
}
let renderer: ReactTestRenderer | undefined;
let agent: HelmetAgent;
function Harness() {
  agent = useHelmetAgent();
  return <output>{agent.navState.phase}</output>;
}
const command = (id: string): JsonEvent => ({
  type: "device.command",
  tier: "low",
  commandId: id,
  action: "navigation.start",
  args: { query: "外滩" }
});
const route = (id: string): JsonEvent => ({
  type: "nav.route",
  commandId: id,
  destinationName: "外滩",
  destination: MOCK_ROUTE.polyline.at(-1),
  distanceMeters: MOCK_ROUTE.distanceMeters,
  etaSeconds: MOCK_ROUTE.etaSeconds,
  polyline: MOCK_ROUTE.polyline,
  steps: MOCK_ROUTE.steps
});
async function advance(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}
async function fix() {
  act(() => agent.startNavDemo(false));
  await advance(1_000);
  act(() => agent.stopNavDemo());
}
async function replaceSession() {
  await act(async () => agent.setVoiceGender(agent.voiceGender === "female" ? "male" : "female"));
  expect(Socket.instances).toHaveLength(2);
  expect(agent.connectionState).toBe("ready");
  expect(renderer!.root.findByType("output").children).toEqual(["idle"]);
  return Socket.instances[1]!;
}
beforeEach(async () => {
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal("window", {
    location: { protocol: "http:", host: "localhost", search: "" },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  });
  vi.stubGlobal("document", { hidden: false, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("navigator", { language: "en-US" });
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ provider: "mock", capabilities: {} })));
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => {
    await agent.startMic();
  });
  expect(agent.listening).toBe(true);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("navigation ownership across settings-driven relay replacement", () => {
  it("cancels a held first-fix timeout rather than reporting its old command to the new session", async () => {
    const oldSocket = Socket.instances[0]!;
    act(() => oldSocket.receive(command("old-fix")));
    await advance(1_500);
    expect(agent.navState.phase).toBe("locating");
    const replacement = await replaceSession();
    await advance(10_000);
    expect(agent.navState.phase).toBe("idle");
    expect(replacement.sent.filter((event) => event.type === "device.result")).toEqual([]);
    expect(oldSocket.sent.filter((event) => event.type === "device.result")).toEqual([]);
  });

  it.each(["requesting", "guiding"] as const)("drops %s session ids and accepts a fresh navigation", async (phase) => {
    const oldSocket = Socket.instances[0]!;
    await fix();
    act(() => oldSocket.receive(command("old-route")));
    expect(agent.navState.phase).toBe("requesting");
    if (phase === "guiding") act(() => oldSocket.receive(route("old-route")));
    expect(agent.navState.phase).toBe(phase);
    const replacement = await replaceSession();
    act(() => {
      oldSocket.receive(route("old-route"));
      replacement.receive(route("old-route"));
    });
    await advance(10_000);
    expect(agent.navState.phase).toBe("idle");
    expect(replacement.sent.filter((event) => ["nav.prompt", "device.result"].includes(String(event.type)))).toEqual(
      []
    );

    await fix();
    act(() => replacement.receive(command("fresh-route")));
    expect(replacement.sent.at(-1)).toMatchObject({ type: "nav.request", commandId: "fresh-route" });
    act(() => replacement.receive(route("fresh-route")));
    expect(agent.navState.phase).toBe("guiding");
    expect(replacement.sent.at(-1)).toEqual({ type: "device.result", commandId: "fresh-route", status: "ok" });
  });
});
