import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompanionRegistry, type HelmetPeer } from "../server/companion-registry";
import { createCompanionBindingStore } from "../server/companion-store";
import { metrics, testingSnapshot } from "../server/metrics";
import type { AgentProvider } from "../server/providers/types";
import { AgentSessionController, type AgentSessionHooks, type ProviderFactory } from "../server/session-controller";
import { resetUserMemoryForTests, userConversationMemory } from "../server/user-memory";
import {
  buildIntentGuidancePrompt,
  buildPersonalityPrompt,
  buildSafetyPrompt,
  buildSessionMemoryPrompt,
  createSessionMemory,
  inferIntent,
  responseModeForRide,
  restoreSessionMemory,
  updateSessionMemory
} from "../shared/session";

function makeProvider(overrides: Partial<AgentProvider> = {}): AgentProvider {
  return {
    start: async () => undefined,
    startAudio: async () => undefined,
    sendAudio: async () => undefined,
    stopAudio: async () => undefined,
    close: async () => undefined,
    ...overrides
  };
}

function startEvent(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      type: "session.start",
      sampleRate: 16_000,
      channels: 1,
      ...overrides
    })
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  metrics.reset();
  resetUserMemoryForTests();
});

describe("stable RDK session registration", () => {
  it("attaches once after provider start, forwards events, and detaches once on close", async () => {
    const order: string[] = [];
    const sent: string[] = [];
    const detach = vi.fn(() => order.push("detach"));
    let peer: HelmetPeer | undefined;
    const hooks: AgentSessionHooks = {
      deviceRegistrationAuthorized: true,
      onDeviceRegistered(candidate) {
        order.push("attach");
        peer = candidate;
        candidate.send({ type: "companion.pairing", code: "123456", expiresAt: 2_000, paired: false });
        return detach;
      }
    };
    const client = { readyState: 1, OPEN: 1, send: (payload: string) => sent.push(payload), close: vi.fn() } as never;
    const controller = new AgentSessionController(
      client,
      () =>
        makeProvider({
          start: async () => {
            order.push("provider.start");
          }
        }),
      undefined,
      "127.0.0.1",
      undefined,
      undefined,
      hooks
    );

    await controller.handleMessage(
      startEvent({
        deviceId: "rdk-11111111-1111-4111-8111-111111111111",
        deviceLabel: "  Trail helmet  ",
        platform: "embedded"
      }),
      false
    );
    await controller.handleMessage(
      startEvent({ deviceId: "rdk-11111111-1111-4111-8111-111111111111", platform: "embedded" }),
      false
    );

    expect(order).toEqual(["provider.start", "attach"]);
    expect(peer).toMatchObject({
      deviceId: "rdk-11111111-1111-4111-8111-111111111111",
      deviceLabel: "Trail helmet"
    });
    peer?.send({
      type: "phone.location",
      sequence: 7,
      lat: 31.2304,
      lon: 121.4737,
      horizontalAccuracyMeters: 5,
      timestamp: 1_000
    });
    expect(sent.map((payload) => JSON.parse(payload) as { type: string }).map((event) => event.type)).toEqual([
      "connection",
      "companion.pairing",
      "error",
      "phone.location"
    ]);

    await controller.close();
    await controller.close();
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it("uses RDK X5 as the fallback label and never attaches sessions without a device identity", async () => {
    const peers: HelmetPeer[] = [];
    const hooks: AgentSessionHooks = {
      deviceRegistrationAuthorized: true,
      onDeviceRegistered(peer) {
        peers.push(peer);
        return () => undefined;
      }
    };
    const client = { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } as never;
    const first = new AgentSessionController(
      client,
      () => makeProvider(),
      undefined,
      "127.0.0.1",
      undefined,
      undefined,
      hooks
    );
    await first.handleMessage(
      startEvent({
        deviceId: "rdk-22222222-2222-4222-8222-222222222222",
        deviceLabel: "   ",
        platform: "embedded"
      }),
      false
    );
    await first.close();

    const second = new AgentSessionController(
      client,
      () => makeProvider(),
      undefined,
      "127.0.0.1",
      undefined,
      undefined,
      hooks
    );
    await second.handleMessage(startEvent({ deviceLabel: "mobile app", platform: "ios" }), false);
    await second.close();

    expect(peers).toHaveLength(1);
    expect(peers[0]?.deviceLabel).toBe("RDK X5");
  });

  it("does not attach when provider startup fails", async () => {
    const onDeviceRegistered = vi.fn(() => () => undefined);
    const client = { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } as never;
    const controller = new AgentSessionController(
      client,
      () =>
        makeProvider({
          start: async () => {
            throw new Error("upstream unavailable");
          }
        }),
      undefined,
      "127.0.0.1",
      undefined,
      undefined,
      { deviceRegistrationAuthorized: true, onDeviceRegistered }
    );

    await controller.handleMessage(
      startEvent({ deviceId: "rdk-33333333-3333-4333-8333-333333333333", platform: "embedded" }),
      false
    );

    expect(onDeviceRegistered).not.toHaveBeenCalled();
  });

  it("closes provider and tester state exactly once when device registration throws", async () => {
    const providerClose = vi.fn(async () => undefined);
    const socketClose = vi.fn();
    const controller = new AgentSessionController(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: socketClose } as never,
      () => makeProvider({ close: providerClose }),
      undefined,
      "127.0.0.1",
      undefined,
      undefined,
      {
        deviceRegistrationAuthorized: true,
        onDeviceRegistered() {
          throw new Error("registry unavailable");
        }
      }
    );

    await controller.handleMessage(
      startEvent({
        deviceId: "rdk-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        testerId: "throwing-registration",
        platform: "embedded"
      }),
      false
    );
    await Promise.all([controller.close(), controller.close()]);

    expect(socketClose).toHaveBeenCalledWith(1011, expect.any(String));
    expect(providerClose).toHaveBeenCalledTimes(1);
    expect(testingSnapshot().totals.activeTestSessions).toBe(0);
    expect(testingSnapshot().sessions).toHaveLength(1);
  });

  it("makes concurrent closes await one cleanup and invokes an acquired detach once", async () => {
    const providerCloseEntered = deferred();
    const releaseProviderClose = deferred();
    const providerClose = vi.fn(async () => {
      providerCloseEntered.resolve();
      await releaseProviderClose.promise;
    });
    const detach = vi.fn();
    const controller = new AgentSessionController(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } as never,
      () => makeProvider({ close: providerClose }),
      undefined,
      "127.0.0.1",
      undefined,
      undefined,
      { deviceRegistrationAuthorized: true, onDeviceRegistered: () => detach }
    );
    await controller.handleMessage(
      startEvent({ deviceId: "rdk-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", platform: "embedded" }),
      false
    );

    const firstClose = controller.close();
    await providerCloseEntered.promise;
    let secondSettled = false;
    const secondClose = controller.close().then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    releaseProviderClose.resolve();
    await Promise.all([firstClose, secondClose]);
    expect(providerClose).toHaveBeenCalledTimes(1);
    expect(detach).toHaveBeenCalledTimes(1);
    expect(testingSnapshot().totals.activeTestSessions).toBe(0);
  });

  it("does not displace a live registry peer when close races provider startup", async () => {
    const store = createCompanionBindingStore({ filePath: null });
    const codes = ["123456", "234567"];
    const registry = createCompanionRegistry({ store, randomCode: () => codes.shift() ?? "999999" });
    const liveHelmetEvents: Array<Record<string, unknown>> = [];
    const liveHelmetSpoken: string[] = [];
    const detachLiveHelmet = registry.attachHelmet({
      deviceId: "rdk-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      deviceLabel: "Live helmet",
      send: (event) => liveHelmetEvents.push(event),
      speak: (text) => liveHelmetSpoken.push(text)
    });
    const providerStartEntered = deferred();
    const releaseProviderStart = deferred();
    const providerClose = vi.fn(async () => undefined);
    const controller = new AgentSessionController(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } as never,
      () =>
        makeProvider({
          start: async () => {
            providerStartEntered.resolve();
            await releaseProviderStart.promise;
          },
          close: providerClose
        }),
      undefined,
      "127.0.0.1",
      undefined,
      undefined,
      { deviceRegistrationAuthorized: true, onDeviceRegistered: (peer) => registry.attachHelmet(peer) }
    );

    const starting = controller.handleMessage(
      startEvent({ deviceId: "rdk-cccccccc-cccc-4ccc-8ccc-cccccccccccc", platform: "embedded" }),
      false
    );
    await providerStartEntered.promise;
    const closing = controller.close();
    releaseProviderStart.resolve();
    await Promise.all([starting, closing]);

    const phoneEvents: Array<Record<string, unknown>> = [];
    const phone = registry.attachCompanion({
      accountId: "live-account",
      address: "127.0.0.1",
      send: (event) => phoneEvents.push(event)
    });
    await phone.handle({ type: "companion.pair", code: "123456" });

    expect(store.bindingForAccount("live-account")?.deviceId).toBe("rdk-cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(phoneEvents.at(-1)).toMatchObject({ type: "companion.status", state: "ready" });
    expect(liveHelmetEvents.at(-1)).toMatchObject({ type: "phone.location.status", state: "connected" });
    expect(providerClose).toHaveBeenCalledTimes(1);
    expect(testingSnapshot().totals.activeTestSessions).toBe(0);

    phone.detach();
    detachLiveHelmet();
    await registry.close();
  });

  it("closes an unauthorized device registration with policy code 1008 before provider start", async () => {
    const start = vi.fn(async () => undefined);
    const close = vi.fn();
    const client = { readyState: 1, OPEN: 1, send: vi.fn(), close } as never;
    const controller = new AgentSessionController(
      client,
      () => makeProvider({ start }),
      undefined,
      "127.0.0.1",
      undefined,
      undefined,
      { deviceRegistrationAuthorized: false }
    );

    await controller.handleMessage(
      startEvent({ deviceId: "rdk-44444444-4444-4444-8444-444444444444", platform: "embedded" }),
      false
    );

    expect(close).toHaveBeenCalledWith(1008, expect.any(String));
    expect(start).not.toHaveBeenCalled();
  });

  it.each(["not-an-rdk-id", "", 42, null])(
    "policy-closes an unauthorized deviceId claim before validating %j",
    async (deviceId) => {
      const start = vi.fn(async () => undefined);
      const providerClose = vi.fn(async () => undefined);
      const onDeviceRegistered = vi.fn(() => () => undefined);
      const socketClose = vi.fn();
      const controller = new AgentSessionController(
        { readyState: 1, OPEN: 1, send: vi.fn(), close: socketClose } as never,
        () => makeProvider({ start, close: providerClose }),
        undefined,
        "127.0.0.1",
        undefined,
        undefined,
        { deviceRegistrationAuthorized: false, onDeviceRegistered }
      );

      await controller.handleMessage(startEvent({ deviceId, platform: "embedded" }), false);
      await controller.close();

      expect(socketClose).toHaveBeenCalledWith(1008, expect.any(String));
      expect(start).not.toHaveBeenCalled();
      expect(onDeviceRegistered).not.toHaveBeenCalled();
      expect(providerClose).toHaveBeenCalledTimes(1);
    }
  );

  it("drops a no-device session.start queued behind a terminal unauthorized claim", async () => {
    const providerStart = vi.fn(async () => undefined);
    const providerClose = vi.fn(async () => undefined);
    const onDeviceRegistered = vi.fn(() => () => undefined);
    const socketClose = vi.fn();
    const controller = new AgentSessionController(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: socketClose } as never,
      () => makeProvider({ start: providerStart, close: providerClose }),
      undefined,
      "127.0.0.1",
      undefined,
      undefined,
      { deviceRegistrationAuthorized: false, onDeviceRegistered }
    );

    const unauthorized = controller.handleMessage(startEvent({ deviceId: null, platform: "embedded" }), false);
    const pipelinedStart = controller.handleMessage(startEvent({ platform: "web" }), false);
    await Promise.all([unauthorized, pipelinedStart]);
    await Promise.all([controller.close(), controller.close()]);

    expect(socketClose).toHaveBeenCalledTimes(1);
    expect(socketClose).toHaveBeenCalledWith(1008, expect.any(String));
    expect(providerStart).not.toHaveBeenCalled();
    expect(onDeviceRegistered).not.toHaveBeenCalled();
    expect(providerClose).toHaveBeenCalledTimes(1);
    expect(testingSnapshot().totals.activeTestSessions).toBe(0);
    expect(testingSnapshot().totals.totalTestSessions).toBe(0);
  });

  it("keeps malformed authorized and no-claim sessions on the ordinary error path", async () => {
    for (const testCase of [
      { hooks: { deviceRegistrationAuthorized: true }, event: { deviceId: "bad-id", platform: "embedded" } },
      { hooks: { deviceRegistrationAuthorized: false }, event: { sampleRate: 8_000, platform: "web" } }
    ]) {
      const send = vi.fn();
      const close = vi.fn();
      const start = vi.fn(async () => undefined);
      const controller = new AgentSessionController(
        { readyState: 1, OPEN: 1, send, close } as never,
        () => makeProvider({ start }),
        undefined,
        "127.0.0.1",
        undefined,
        undefined,
        testCase.hooks
      );

      await controller.handleMessage(startEvent(testCase.event), false);

      expect(close).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(
        send.mock.calls.some(([payload]) => (JSON.parse(String(payload)) as { type?: string }).type === "error")
      ).toBe(true);
      await controller.close();
    }
  });

  it("delivers pairing and phone location without adding QA or user-memory evidence", async () => {
    const userId = "55555555-5555-4555-8555-555555555555";
    const sent: Array<Record<string, unknown>> = [];
    let peer: HelmetPeer | undefined;
    const client = {
      readyState: 1,
      OPEN: 1,
      send(payload: string) {
        sent.push(JSON.parse(payload) as Record<string, unknown>);
      },
      close: vi.fn()
    } as never;
    const providerFactory: ProviderFactory = (socket, telemetry) =>
      makeProvider({
        start: async () => {
          const ordinary = { type: "transcript", speaker: "agent", text: "Ordinary evidence", final: true };
          const encoded = JSON.stringify(ordinary);
          socket.send(encoded);
          telemetry.serverEvent(ordinary, Buffer.byteLength(encoded));
        }
      });
    const controller = new AgentSessionController(
      client,
      providerFactory,
      undefined,
      "127.0.0.1",
      undefined,
      { id: userId, username: "privacy-rider" },
      {
        deviceRegistrationAuthorized: true,
        onDeviceRegistered(candidate) {
          peer = candidate;
          candidate.send({ type: "companion.pairing", code: "654321", expiresAt: 2_000, paired: false });
          return () => undefined;
        }
      }
    );

    await controller.handleMessage(
      startEvent({ deviceId: "rdk-55555555-5555-4555-8555-555555555555", platform: "embedded" }),
      false
    );
    peer?.send({
      type: "phone.location",
      sequence: 1,
      lat: 31.2304,
      lon: 121.4737,
      horizontalAccuracyMeters: 4,
      timestamp: 1_000
    });
    await controller.close();

    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "companion.pairing", code: "654321" }),
        expect.objectContaining({ type: "phone.location", lat: 31.2304, lon: 121.4737 })
      ])
    );
    expect(testingSnapshot().sessions).toHaveLength(1);
    expect(testingSnapshot().sessions[0]).toMatchObject({ serverEvents: 1 });
    expect(userConversationMemory(userId)?.turns.map((turn) => turn.text)).toEqual(["Ordinary evidence"]);
  });
});

describe("companion discovery session wiring", () => {
  it("supplies a speak callback that routes through provider.speakNavLine", async () => {
    const spoken: string[] = [];
    let peer: HelmetPeer | undefined;
    const provider = makeProvider({ speakNavLine: (text: string) => void spoken.push(text) });
    const controller = new AgentSessionController(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } as never,
      () => provider,
      undefined,
      "203.0.113.5",
      undefined,
      undefined,
      {
        deviceRegistrationAuthorized: true,
        onDeviceRegistered: (registered) => {
          peer = registered;
          return () => undefined;
        }
      }
    );
    await controller.handleMessage(startEvent({ deviceId: "rdk-11111111-1111-4111-8111-111111111111" }), false);
    peer?.speak("检测到配对请求");
    expect(spoken).toEqual(["检测到配对请求"]);
  });

  it("stops routing speak through the provider once the session has closed", async () => {
    const spoken: string[] = [];
    let peer: HelmetPeer | undefined;
    const provider = makeProvider({ speakNavLine: (text: string) => void spoken.push(text) });
    const controller = new AgentSessionController(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } as never,
      () => provider,
      undefined,
      "203.0.113.5",
      undefined,
      undefined,
      {
        deviceRegistrationAuthorized: true,
        onDeviceRegistered: (registered) => {
          peer = registered;
          return () => undefined;
        }
      }
    );
    await controller.handleMessage(startEvent({ deviceId: "rdk-22222222-2222-4222-8222-222222222222" }), false);
    await controller.close();
    peer?.speak("检测到配对请求");
    expect(spoken).toEqual([]);
  });

  it("forwards final rider transcripts to onRiderUtterance with the registered deviceId", async () => {
    const utterances: Array<{ deviceId: string; text: string }> = [];
    let serverEventTap: ((payload: unknown, bytes: number) => void) | undefined;
    const factory: ProviderFactory = (_client, telemetry) => {
      serverEventTap = telemetry.serverEvent;
      return makeProvider();
    };
    const controller = new AgentSessionController(
      { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() } as never,
      factory,
      undefined,
      "203.0.113.5",
      undefined,
      undefined,
      {
        deviceRegistrationAuthorized: true,
        onDeviceRegistered: () => () => undefined,
        onRiderUtterance: (deviceId, text) => void utterances.push({ deviceId, text })
      }
    );
    await controller.handleMessage(startEvent({ deviceId: "rdk-11111111-1111-4111-8111-111111111111" }), false);
    serverEventTap?.(
      { type: "transcript", turnId: "t1", deliveryId: "d1", speaker: "rider", text: "确认", final: true },
      10
    );
    serverEventTap?.(
      { type: "transcript", turnId: "t1", deliveryId: "d2", speaker: "rider", text: "确", final: false },
      10
    );
    serverEventTap?.(
      { type: "transcript", turnId: "t2", deliveryId: "d3", speaker: "agent", text: "确认", final: true },
      10
    );
    expect(utterances).toEqual([{ deviceId: "rdk-11111111-1111-4111-8111-111111111111", text: "确认" }]);
  });
});

describe("session memory and safety policy", () => {
  it("detects emergency intent and escalates response mode", () => {
    expect(inferIntent("I crashed and need help")).toBe("emergency");
    expect(responseModeForRide("ride", "emergency")).toBe("emergency");
  });

  it("detects common crash phrasings as emergencies", () => {
    expect(inferIntent("我摔倒了")).toBe("emergency");
    expect(inferIntent("我出车祸了")).toBe("emergency");
    expect(inferIntent("受了伤，需要帮忙")).toBe("emergency");
    expect(inferIntent("quick, I fell and I'm hurt")).toBe("emergency");
  });

  it("does not match intent keywords inside unrelated words", () => {
    // "rain" in "train", "tire" in "tired", "eta" in "details", "wind" in
    // "window", 风 in 麦克风 — all previously misclassified.
    expect(inferIntent("route to the train station")).toBe("navigation");
    expect(inferIntent("I'm tired, let's stop soon")).toBe("casual");
    expect(inferIntent("give me the details")).toBe("casual");
    expect(inferIntent("close the helmet window vents")).toBe("casual");
    expect(inferIntent("麦克风好像坏了")).toBe("casual");
  });

  it("keeps riding and navigation responses concise", () => {
    expect(responseModeForRide("ride", "casual")).toBe("concise");
    expect(responseModeForRide("navigation", "weather")).toBe("concise");
    expect(responseModeForRide("stop", "weather")).toBe("normal");
  });

  it("updates language, intent, destination, and response mode from rider text", () => {
    const memory = updateSessionMemory(createSessionMemory("navigation"), "帮我回家，前面堵吗？", "navigation");

    expect(memory.language).toBe("zh");
    expect(memory.lastIntent).toBe("navigation");
    expect(memory.destination).toBe("家");
    expect(memory.responseMode).toBe("concise");
  });

  it("keeps the session language when a Chinese rider drops one short Latin token", () => {
    const zhMemory = updateSessionMemory(createSessionMemory("ride"), "帮我看看天气", "ride");
    expect(zhMemory.language).toBe("zh");
    // "OK" / "yes" must not flip the whole session (prompt + TTS voice) to English…
    expect(updateSessionMemory(zhMemory, "OK", "ride").language).toBe("zh");
    expect(updateSessionMemory(zhMemory, "yes", "ride").language).toBe("zh");
    // …while distinctly English speech still switches…
    expect(updateSessionMemory(zhMemory, "what's the weather like", "ride").language).toBe("en");
    // …and any Han character switches straight back.
    const enMemory = updateSessionMemory(zhMemory, "navigate home please", "ride");
    expect(enMemory.language).toBe("en");
    expect(updateSessionMemory(enMemory, "好的", "ride").language).toBe("zh");
  });

  it("does not flip to English on a single long Latin token (e.g. a road name)", () => {
    const zhMemory = updateSessionMemory(createSessionMemory("ride"), "帮我看看天气", "ride");
    expect(zhMemory.language).toBe("zh");
    // A lone proper noun — however long — is not "distinctly English" and must
    // not flip the whole session (prompt + TTS voice) to English.
    expect(updateSessionMemory(zhMemory, "Gangnam", "ride").language).toBe("zh");
    expect(updateSessionMemory(zhMemory, "Broadway", "ride").language).toBe("zh");
  });

  it("does not classify 风格 (style) or 中风 (stroke) as weather", () => {
    expect(inferIntent("换个说话风格")).toBe("casual");
    expect(inferIntent("有人中风了怎么办")).toBe("casual");
    // Real weather words still match.
    expect(inferIntent("外面风大吗")).toBe("weather");
    expect(inferIntent("台风要来了吗")).toBe("weather");
  });

  it("does not capture Chinese verb complements as destinations", () => {
    // 到/回 appear in everyday verbs (听到 "heard", 迟到 "was late") — only
    // navigation-shaped turns may set a destination.
    expect(updateSessionMemory(createSessionMemory("ride"), "我听到异响了", "ride").destination).toBeUndefined();
    expect(updateSessionMemory(createSessionMemory("ride"), "刚才迟到了十分钟", "ride").destination).toBeUndefined();
    // Fullwidth punctuation ends the capture.
    expect(updateSessionMemory(createSessionMemory("navigation"), "带我回家！", "navigation").destination).toBe("家");
  });

  it("trims a trailing action clause from a punctuation-free Chinese destination", () => {
    // Chinese ASR often emits no mid-utterance punctuation, so the raw capture
    // runs into the following verb clause — keep only the place.
    expect(updateSessionMemory(createSessionMemory("navigation"), "导航到公司门口接我", "navigation").destination).toBe(
      "公司门口"
    );
    expect(updateSessionMemory(createSessionMemory("navigation"), "回家吃个饭", "navigation").destination).toBe("家");
    // …but a place name that merely begins with such a verb must survive intact
    // (小吃街 keeps its 吃; 接待中心 keeps its 接).
    expect(updateSessionMemory(createSessionMemory("navigation"), "导航去小吃街", "navigation").destination).toBe(
      "小吃街"
    );
    expect(updateSessionMemory(createSessionMemory("navigation"), "导航去接待中心", "navigation").destination).toBe(
      "接待中心"
    );
  });

  it("keeps the previous destination when a non-navigation turn follows", () => {
    const withDestination = updateSessionMemory(createSessionMemory("navigation"), "导航回家", "navigation");
    expect(withDestination.destination).toBe("家");
    const afterCasual = updateSessionMemory(withDestination, "今天有点累", "navigation");
    expect(afterCasual.destination).toBe("家");
  });

  it("caps an English destination at the place name, not the trailing clause", () => {
    expect(
      updateSessionMemory(createSessionMemory("navigation"), "navigate to busan station right now please", "navigation")
        .destination
    ).toBe("busan station");
  });

  it("infers an English destination only from destination-bearing phrases", () => {
    // A bare infinitive must not be mistaken for a destination.
    expect(updateSessionMemory(createSessionMemory("ride"), "I want to ride fast", "ride").destination).toBeUndefined();
    // A real navigation phrase still captures the place.
    expect(
      updateSessionMemory(createSessionMemory("navigation"), "navigate to busan station", "navigation").destination
    ).toBe("busan station");
  });

  it("maps each personality to its own prompt fragment", () => {
    expect(buildPersonalityPrompt("concise")).toContain("极简");
    expect(buildPersonalityPrompt("friendly")).toContain("友好");
    expect(buildPersonalityPrompt("technical")).toContain("技术型");
    expect(buildPersonalityPrompt("rally")).toContain("领航员");
  });

  it("gives intent-specific guidance and falls back to the language rule", () => {
    expect(buildIntentGuidancePrompt("navigation")).toContain("导航");
    expect(buildIntentGuidancePrompt("emergency")).toContain("紧急");
    expect(buildIntentGuidancePrompt("diagnostics")).toContain("诊断");
    // Undefined intent → the generic language-rule fallback.
    expect(buildIntentGuidancePrompt(undefined)).toContain("语言规则");
  });

  it("adds the high-speed policy and telemetry above 60 km/h", () => {
    const memory = createSessionMemory("ride");
    const prompt = buildSafetyPrompt(
      { mode: "ride", scenario: "commute", speedKmh: 72, routePhase: "highway", network: "online", batteryPct: 64 },
      memory
    );
    expect(prompt).toContain("高速");
    expect(prompt).toContain("72");
    expect(prompt).toContain("highway");
    expect(prompt).toContain("64%");
  });

  it("restores a client memory snapshot across a session restart", () => {
    const memory = restoreSessionMemory(
      { language: "en", destination: "  busan station  ", lastIntent: "navigation" },
      "navigation"
    );

    expect(memory.language).toBe("en");
    expect(memory.destination).toBe("busan station");
    expect(memory.lastIntent).toBe("navigation");
    // responseMode is re-derived from the current mode + intent, not restored.
    expect(memory.responseMode).toBe("concise");
  });

  it("does not let a stale emergency intent pin emergency verbosity after restart", () => {
    // The rider said 报警 hours ago, then toggled a setting while parked: the
    // restored snapshot must not resurrect emergency command-style replies.
    const memory = restoreSessionMemory({ language: "zh", lastIntent: "emergency" }, "stop");
    expect(memory.lastIntent).toBe("emergency");
    expect(memory.responseMode).toBe("normal");
    // A genuinely ongoing emergency is carried by the current ride mode.
    expect(restoreSessionMemory({ lastIntent: "emergency" }, "emergency").responseMode).toBe("emergency");
  });

  it("falls back to fresh memory for missing or invalid snapshots", () => {
    expect(restoreSessionMemory(undefined, "ride")).toEqual(createSessionMemory("ride"));

    const sanitized = restoreSessionMemory(
      { language: "fr", destination: "x".repeat(200), lastIntent: "hack-the-planet" },
      "ride"
    );
    expect(sanitized.language).toBe("zh");
    expect(sanitized.destination).toHaveLength(64);
    expect(sanitized.lastIntent).toBeUndefined();
  });

  it("builds compact prompt fragments for Doubao", () => {
    const memory = {
      ...createSessionMemory("emergency"),
      lastIntent: "emergency" as const,
      destination: "医院"
    };
    const memoryPrompt = buildSessionMemoryPrompt(memory);
    const safetyPrompt = buildSafetyPrompt({ mode: "emergency", scenario: "emergency", speedKmh: 18 }, memory);

    expect(memoryPrompt).toContain("医院");
    expect(safetyPrompt).toContain("紧急模式");
    expect(safetyPrompt).toContain("18");
  });
});
