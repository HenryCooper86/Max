import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderHudPage } from "../rdk/agent/src/hud/server";
import type { HudState } from "../rdk/agent/src/hud/state";

// Substituted the way createHudServer substitutes, so this exercises the page
// as served rather than the template.
const page = renderHudPage(readFileSync(new URL("../rdk/agent/src/hud/index.html", import.meta.url), "utf8"), 8081, "");

class FakeClassList {
  constructor(private readonly element: FakeElement) {}

  private classes(): Set<string> {
    return new Set(this.element.className.split(/\s+/).filter(Boolean));
  }

  contains(name: string): boolean {
    return this.classes().has(name);
  }

  toggle(name: string, force?: boolean): boolean {
    const classes = this.classes();
    const enabled = force ?? !classes.has(name);
    if (enabled) classes.add(name);
    else classes.delete(name);
    this.element.className = [...classes].join(" ");
    return enabled;
  }
}

class FakeElement {
  textContent = "";
  hidden = false;
  className = "";
  src = "";
  dataset: Record<string, string> = {};
  readonly classList = new FakeClassList(this);
  innerHTMLWrites = 0;
  private html = "";

  constructor(readonly id: string) {}

  get innerHTML(): string {
    return this.html;
  }

  set innerHTML(value: string) {
    this.innerHTMLWrites += 1;
    this.html = value;
  }

  addEventListener(): void {}

  closest(): null {
    return null;
  }
}

type RenderHarness = {
  elements: Map<string, FakeElement>;
  render(state: HudState): void;
  runTimeouts(): void;
  /** Every URL the page handed to `new WebSocket`. */
  socketUrls: string[];
};

function renderHarness(src: string = page): RenderHarness {
  const ids = new Set([...src.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!));
  for (const id of ["navigation-card", "phone-status", "nav-instruction", "nav-distance", "nav-summary", "nav-paused"])
    ids.add(id);
  const elements = new Map([...ids].map((id) => [id, new FakeElement(id)]));
  for (const match of src.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const tag = match[0];
    const element = elements.get(match[1]!)!;
    element.className = /\bclass="([^"]*)"/.exec(tag)?.[1] ?? "";
    element.hidden = /\shidden(?:\s|>|=)/.test(tag);
  }

  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    addEventListener: () => undefined
  };
  const sockets: Array<{ onmessage?: (message: { data: string }) => void }> = [];
  const socketUrls: string[] = [];
  let nextTimerId = 1;
  const timers = new Map<number, () => void>();
  class FakeWebSocket {
    onmessage?: (message: { data: string }) => void;

    constructor(url: string) {
      socketUrls.push(url);
      sockets.push(this);
    }
  }
  const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(scripts).toHaveLength(1);
  const run = new Function(
    "document",
    "WebSocket",
    "location",
    "fetch",
    "setInterval",
    "setTimeout",
    "clearTimeout",
    "confirm",
    "alert",
    scripts[0]![1]!
  );
  run(
    document,
    FakeWebSocket,
    { hostname: "rdk.local", host: "rdk.local:8787" },
    () => new Promise(() => {}),
    () => 0,
    (callback: () => void) => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    (id: number) => timers.delete(id),
    () => false,
    () => undefined
  );
  const socket = sockets[0];
  expect(socket?.onmessage).toBeTypeOf("function");
  return {
    elements,
    socketUrls,
    render(state): void {
      socket!.onmessage!({ data: JSON.stringify(state) });
    },
    runTimeouts(): void {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    }
  };
}

function state(overrides: Partial<HudState> = {}): HudState {
  return {
    connection: "ready",
    turnState: "idle",
    transcript: [],
    latencyMs: null,
    lastError: null,
    companion: {
      paired: true,
      locationState: "sharing",
      horizontalAccuracyMeters: 8,
      lastFixAgeMs: 2_200
    },
    navigation: {
      phase: "guiding",
      destinationName: "人民广场",
      instruction: "前方右转进入西藏中路",
      distanceToManeuverMeters: 180,
      remainingMeters: 3_200,
      remainingSeconds: 720,
      offRoute: false
    },
    discovery: "off",
    ...overrides
  };
}

function element(harness: RenderHarness, id: string): FakeElement {
  return harness.elements.get(id)!;
}

describe("RDK HUD navigation card", () => {
  it("places the exact hidden card before the existing camera row", () => {
    const cardStart = page.indexOf('<section id="navigation-card" class="card nav" hidden>');
    const cameraRow = page.indexOf('<div class="row">');
    expect(cardStart).toBeGreaterThan(-1);
    expect(cameraRow).toBeGreaterThan(cardStart);
    expect(page.slice(cardStart, page.indexOf("</section>", cardStart) + 10)).toContain(
      '<div id="phone-status" class="muted"></div>\n  <div id="nav-instruction"></div>\n  <div id="nav-distance"></div>\n  <div id="nav-summary" class="muted"></div>\n  <div id="nav-paused" class="warning" hidden>手机定位已断开 · 导航暂停</div>'
    );
  });

  it("shows the mdns broadcast status beside the companion pairing row", () => {
    const harness = renderHarness();
    harness.render(state({ discovery: "mdns" }));

    expect(element(harness, "discovery-status").textContent).toBe("配对广播 mdns");
  });

  it("clears the broadcast status along with the rest of the card when it hides", () => {
    const harness = renderHarness();
    harness.render(state({ discovery: "mdns" }));
    harness.render(
      state({ navigation: null, discovery: "off", companion: { paired: true, locationState: "connected" } })
    );

    expect(element(harness, "navigation-card").hidden).toBe(true);
    expect(element(harness, "discovery-status").textContent).toBe("");
  });

  it("renders turn-first guidance, GPS quality, destination, remaining distance, and ETA", () => {
    const harness = renderHarness();
    harness.render(state());

    expect(element(harness, "navigation-card").hidden).toBe(false);
    expect(element(harness, "phone-status").textContent).toBe("手机 GPS 共享中 · 精度 ±8 m · 2 秒前");
    expect(element(harness, "nav-instruction").textContent).toBe("前方右转进入西藏中路");
    expect(element(harness, "nav-distance").textContent).toBe("180 m");
    expect(element(harness, "nav-summary").textContent).toBe("人民广场 · 剩余 3.2 km · 预计 12 分钟");
    expect(element(harness, "nav-paused").hidden).toBe(true);
  });

  it("shows an unexpired code only while unpaired and hides it at the expiry boundary or once paired", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(20_000);
    const harness = renderHarness();
    const companion = {
      paired: false,
      pairingCode: "123456",
      pairingExpiresAt: 20_001,
      locationState: "unpaired" as const
    };

    harness.render(state({ companion }));
    expect(element(harness, "phone-status").textContent).toContain("配对码 123456");

    harness.render(state({ companion: { ...companion, pairingExpiresAt: 20_000 } }));
    expect(element(harness, "phone-status").textContent).not.toContain("123456");

    harness.render(state({ companion: { ...companion, paired: true, locationState: "connected" } }));
    expect(element(harness, "phone-status").textContent).not.toContain("123456");
    now.mockRestore();
  });

  it("shows the pairing code and expiry before navigation exists", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(20_000);
    const harness = renderHarness();
    harness.render(
      state({
        companion: {
          paired: false,
          pairingCode: "123456",
          pairingExpiresAt: 80_000,
          locationState: "unpaired"
        },
        navigation: null
      })
    );

    expect(element(harness, "navigation-card").hidden).toBe(false);
    expect(element(harness, "phone-status").textContent).toBe("配对码 123456 · 1 分钟内有效");
    expect(element(harness, "nav-instruction").textContent).toBe("");
    expect(element(harness, "nav-distance").textContent).toBe("");
    expect(element(harness, "nav-summary").textContent).toBe("");
    expect(element(harness, "nav-paused").hidden).toBe(true);
    now.mockRestore();
  });

  it("hides and clears a pairing-only card at the exact expiry boundary without another socket frame", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(20_000);
    const harness = renderHarness();
    harness.render(
      state({
        companion: {
          paired: false,
          pairingCode: "123456",
          pairingExpiresAt: 20_001,
          locationState: "unpaired"
        },
        navigation: null
      })
    );
    expect(element(harness, "navigation-card").hidden).toBe(false);

    now.mockReturnValue(20_001);
    harness.runTimeouts();
    expect(element(harness, "navigation-card").hidden).toBe(true);
    expect(element(harness, "phone-status").textContent).toBe("");
    now.mockRestore();
  });

  it("hides a pairing-only card when pairing succeeds", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(20_000);
    const harness = renderHarness();
    harness.render(
      state({
        companion: {
          paired: false,
          pairingCode: "123456",
          pairingExpiresAt: 80_000,
          locationState: "unpaired"
        },
        navigation: null
      })
    );
    harness.render(
      state({
        companion: { paired: true, locationState: "connected" },
        navigation: null
      })
    );

    expect(element(harness, "navigation-card").hidden).toBe(true);
    expect(element(harness, "phone-status").textContent).toBe("");
    harness.runTimeouts();
    expect(element(harness, "navigation-card").hidden).toBe(true);
    now.mockRestore();
  });

  it.each([
    {
      paired: false,
      pairingCode: "123456",
      pairingExpiresAt: 20_000,
      locationState: "unpaired" as const
    },
    { paired: false, locationState: "unpaired" as const }
  ])("hides an expired or missing-code unpaired card when navigation is null", (companion) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(20_000);
    const harness = renderHarness();
    harness.render(state({ companion, navigation: null }));

    expect(element(harness, "navigation-card").hidden).toBe(true);
    expect(element(harness, "phone-status").textContent).toBe("");
    now.mockRestore();
  });

  it("removes a displayed pairing code when its expiry boundary passes without another socket message", () => {
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(20_000).mockReturnValue(20_001);
    const harness = renderHarness();
    harness.render(
      state({
        companion: {
          paired: false,
          pairingCode: "123456",
          pairingExpiresAt: 20_001,
          locationState: "unpaired"
        }
      })
    );
    expect(element(harness, "phone-status").textContent).toContain("123456");

    harness.runTimeouts();
    expect(element(harness, "phone-status").textContent).toBe("手机未配对");
    expect(element(harness, "navigation-card").hidden).toBe(false);
    expect(element(harness, "nav-instruction").textContent).toBe("前方右转进入西藏中路");
    now.mockRestore();
  });

  it.each([
    ["connected", "手机 GPS 已连接"],
    ["sharing", "手机 GPS 共享中"],
    ["stopped", "手机 GPS 已停止"],
    ["stale", "手机 GPS 信号过期"],
    ["unpaired", "手机未配对"]
  ] as const)("renders the %s phone connection truth", (locationState, expected) => {
    const harness = renderHarness();
    harness.render(state({ companion: { paired: locationState !== "unpaired", locationState } }));
    expect(element(harness, "phone-status").textContent).toBe(expected);
  });

  it("marks rerouting and off-route guidance as abnormal rather than ordinary live guidance", () => {
    const harness = renderHarness();
    harness.render(state({ navigation: { ...state().navigation!, phase: "rerouting", offRoute: true } }));

    expect(element(harness, "navigation-card").classList.contains("rerouting")).toBe(true);
    expect(element(harness, "navigation-card").classList.contains("off-route")).toBe(true);
    expect(element(harness, "nav-summary").textContent).toContain("偏离路线 · 正在重新规划");
  });

  it("keeps frozen values visible and shows the exact disconnected banner while paused", () => {
    const harness = renderHarness();
    harness.render(
      state({
        navigation: {
          ...state().navigation!,
          phase: "paused",
          instruction: "保持直行",
          distanceToManeuverMeters: 88,
          remainingMeters: 1_600,
          remainingSeconds: 360
        }
      })
    );

    expect(element(harness, "navigation-card").classList.contains("paused")).toBe(true);
    expect(element(harness, "nav-paused").hidden).toBe(false);
    expect(element(harness, "nav-paused").textContent).toBe("手机定位已断开 · 导航暂停");
    expect(element(harness, "nav-instruction").textContent).toBe("保持直行");
    expect(element(harness, "nav-distance").textContent).toBe("88 m");
    expect(element(harness, "nav-summary").textContent).toContain("剩余 1.6 km · 预计 6 分钟");
  });

  it("clears every dynamic navigation field and hides the full card for null navigation", () => {
    const harness = renderHarness();
    harness.render(state());
    harness.render(state({ navigation: null }));

    expect(element(harness, "navigation-card").hidden).toBe(true);
    expect(element(harness, "phone-status").textContent).toBe("");
    expect(element(harness, "nav-instruction").textContent).toBe("");
    expect(element(harness, "nav-distance").textContent).toBe("");
    expect(element(harness, "nav-summary").textContent).toBe("");
    expect(element(harness, "nav-paused").hidden).toBe(true);
  });

  it("formats meter, kilometer, minute, and hour boundaries without invalid optional values", () => {
    const harness = renderHarness();
    harness.render(
      state({
        navigation: {
          phase: "guiding",
          distanceToManeuverMeters: 999,
          remainingMeters: 1_000,
          remainingSeconds: 3_600
        }
      })
    );
    expect(element(harness, "nav-distance").textContent).toBe("999 m");
    expect(element(harness, "nav-summary").textContent).toBe("剩余 1.0 km · 预计 1 小时");

    harness.render(
      state({
        companion: { paired: true, locationState: "sharing", horizontalAccuracyMeters: Number.NaN },
        navigation: { phase: "guiding", remainingMeters: Number.NaN, remainingSeconds: 59 }
      })
    );
    const rendered = ["phone-status", "nav-instruction", "nav-distance", "nav-summary"]
      .map((id) => element(harness, id).textContent)
      .join(" ");
    expect(element(harness, "nav-summary").textContent).toBe("预计 1 分钟");
    expect(rendered).not.toMatch(/undefined|NaN/);
  });

  it.each([999.5, 999.9, 999.99])("uses kilometers when rounding %s m crosses the unit boundary", (meters) => {
    const harness = renderHarness();
    harness.render(state({ navigation: { ...state().navigation!, distanceToManeuverMeters: meters } }));

    expect(element(harness, "nav-distance").textContent).toBe("1.0 km");
  });

  it("renders hostile destination and instruction values only as text content", () => {
    const harness = renderHarness();
    const instruction = '<img src=x onerror="globalThis.pwned=true">前方左转';
    const destinationName = '</div><script>globalThis.pwned=true</script><div data-x="';
    harness.render(state({ navigation: { ...state().navigation!, instruction, destinationName } }));

    expect(element(harness, "nav-instruction").textContent).toBe(instruction);
    expect(element(harness, "nav-summary").textContent).toContain(destinationName);
    for (const id of ["phone-status", "nav-instruction", "nav-distance", "nav-summary", "nav-paused"])
      expect(element(harness, id).innerHTMLWrites).toBe(0);
  });

  it("keeps the HUD card-only with no map or remote Amap surface", () => {
    expect(page).not.toMatch(/<iframe|<canvas|webapi\.amap|restapi\.amap|amap\.com/i);
  });
});

describe("RDK HUD sidecar URLs", () => {
  const source = readFileSync(new URL("../rdk/agent/src/hud/index.html", import.meta.url), "utf8");

  function previewSrc(token: string): string {
    const rendered = renderHudPage(source, 8081, token);
    const script = /<script>([\s\S]*?)<\/script>/.exec(rendered)![1]!;
    const build = new Function(
      "location",
      `${script.slice(0, script.indexOf('document.getElementById("front")'))} return sidecar("/preview/front");`
    );
    return build({ hostname: "rdk.local", host: "rdk.local:8080" }) as string;
  }

  it("carries the bench token to the sidecar so the browser is admitted", () => {
    expect(previewSrc("s3cret")).toBe("http://rdk.local:8081/preview/front?t=s3cret");
  });

  it("sends no token when the board has none, keeping the loopback-only case clean", () => {
    expect(previewSrc("")).toBe("http://rdk.local:8081/preview/front");
  });

  it("gives the status WebSocket the token too, or the panel starves while the cameras work", () => {
    // Observed on the board: cameras and gallery live, connection/turn/latency
    // /error all "—". Those four come from the socket, and the socket is the
    // one URL `sidecar()` does not build. `location.host` is host:port with no
    // query, so the token never reached the upgrade and it was refused 401
    // while every tokenised fetch beside it succeeded.
    const harness = renderHarness(renderHudPage(source, 8081, "s3cret"));
    expect(harness.socketUrls).toHaveLength(1);
    expect(harness.socketUrls[0]).toContain("t=s3cret");
  });

  it("opens a bare socket when the board has no token, keeping the loopback case clean", () => {
    const harness = renderHarness(renderHudPage(source, 8081, ""));
    expect(harness.socketUrls[0]).not.toContain("t=");
  });

  it("uses a distinct replay cache-buster so it cannot overwrite the token", () => {
    // `t` was the cache-buster on /play before it became the token parameter;
    // reusing it would have made every replay an unauthenticated request.
    expect(page).not.toMatch(/[?&]t=\$\{\+\+streamNonce\}/);
    expect(page).toContain("n: ++streamNonce");
  });
});
