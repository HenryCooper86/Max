import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

class Element {
  hidden = false;
  disabled = false;
  textContent = "";
  innerHTML = "";
  className = "";
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  children: Element[] = [];
  onclick?: () => void;
  onload?: () => void;
  onerror?: () => void;
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  replaceChildren() {
    this.children = [];
  }
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  getBoundingClientRect() {
    return { width: 600, height: 480 };
  }
}
const frame = {
  sequence: 1,
  destination: "人民广场",
  instruction: "右转进入南京东路",
  distance: 120,
  remaining: 2000,
  seconds: 300,
  offRoute: false,
  polyline: [
    { lat: 31.23, lon: 121.47 },
    { lat: 31.24, lon: 121.48 }
  ],
  position: { lat: 31.235, lon: 121.475 },
  turns: [
    { lat: 31.236, lon: 121.476, distance: 120, instruction: "右转" },
    { lat: 31.237, lon: 121.477, distance: 600, instruction: "左转进入中山东一路" }
  ]
};
function harness() {
  let clock = 1_000_000;
  const images: Element[] = [];
  const elements = new Map<string, Element>();
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const page = readFileSync(new URL("../rdk/agent/src/hud-cast/index.html", import.meta.url), "utf8");
  const script = page.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const context = createContext({
    Image: class extends Element {
      constructor() {
        super();
        images.push(this);
      }
    },
    document: {
      getElementById: get,
      createElement: () => new Element(),
      body: { classList: { toggle() {}, add() {} } }
    },
    window: { addEventListener() {} },
    fetch: () => new Promise(() => {}),
    AbortSignal,
    setTimeout() {},
    Date: class extends Date {
      static override now() {
        return clock;
      }
    }
  });
  runInContext(script, context);
  return {
    get,
    loadImage: () => images.at(-1)!.onload!(),
    value: (expression: string) => runInContext(expression, context),
    advance: () => {
      clock += 60_000;
    },
    render: (patch: Record<string, unknown> = {}) => {
      context.state = { connected: true, stale: false, addresses: [], code: null, port: 8080, frame, ...patch };
      runInContext("render(state)", context);
    }
  };
}

describe("detailed HUD route display", () => {
  it("shows the phone player in idle and navigation, retaining paused controls and clearing disconnected controls", () => {
    const h = harness();
    const player = {
      id: "one",
      name: "Max",
      title: "Track",
      artist: "Artist",
      album: "Album",
      status: "playing",
      position: 3000,
      duration: 100000
    };
    const music = { available: true, connected: true, busy: false, player, message: "" };
    h.render({ frame: null, music });
    expect(h.get("idle-music").hidden).toBe(false);
    expect(h.get("nav-music").hidden).toBe(true);
    expect(h.get("idle-music-title").textContent).toBe("Track");
    expect(h.get("idle-music-toggle").attributes["aria-label"]).toBe("暂停");
    h.render({ music: { ...music, player: { ...player, status: "paused" } } });
    expect(h.get("idle-music").hidden).toBe(true);
    expect(h.get("nav-music").hidden).toBe(false);
    expect(h.get("nav-music-toggle").disabled).toBe(false);
    expect(h.get("nav-music-toggle").attributes["aria-label"]).toBe("播放");
    h.render({ music: { ...music, busy: true } });
    expect(h.get("nav-music-next").disabled).toBe(true);
    h.render({ music: { ...music, player: null, connected: false } });
    expect(h.get("nav-music").hidden).toBe(true);
    expect(h.get("nav-music-toggle").disabled).toBe(true);
  });
  it("returns to the clock, weather and pairing dashboard after sharing ends", () => {
    const h = harness();
    h.render();
    expect(h.get("join").hidden).toBe(true);
    h.render({
      connected: false,
      frame: null,
      code: "123456",
      timeZone: "Asia/Shanghai",
      weather: {
        city: "北京",
        condition: "晴",
        temperature: "23",
        humidity: "50",
        wind: "北风 3级",
        reportTime: "2026-09-18 12:00:00",
        source: "network",
        stale: true
      }
    });
    expect(h.get("join").hidden).toBe(false);
    expect(h.get("map-panel").hidden).toBe(true);
    expect(h.get("idle-clock").textContent).toMatch(/\d{2}:\d{2}/);
    expect(h.get("weather-city").textContent).toBe("北京");
    expect(h.get("weather-temperature").textContent).toBe("23°");
    expect(h.get("weather-updated").textContent).toContain("旧数据");
    h.render({ connected: false, frame: null, weather: null });
    expect(h.get("weather-temperature").textContent).toBe("—");
    expect(h.get("weather-condition").textContent).toBe("天气暂不可用");
  });
  it("shows upcoming phone instructions and switches between follow and overview", () => {
    const h = harness();
    h.render();
    expect(h.get("instruction").textContent).toBe(frame.instruction);
    expect(h.get("arrow").textContent).toBe("↱");
    expect(h.get("upcoming").children).toHaveLength(1);
    expect(h.get("upcoming").children[0]!.children[1]!.children[0]!.textContent).toContain("中山东一路");
    expect(h.get("map").innerHTML).toContain('cx="300" cy="240"');
    expect(h.get("camera").textContent).toBe("全程");
    const followed = h.get("map").innerHTML;
    h.get("camera").onclick!();
    expect(h.get("camera").textContent).toBe("跟随");
    expect(h.get("map").innerHTML).not.toBe(followed);
    expect(h.get("scale").textContent).toMatch(/米|公里/);
  });
  it("keeps streets when snapshots stop and updates position directly on the image", () => {
    const h = harness();
    const basemap = { sequence: 1, center: frame.position, zoom: 16 };
    h.render({ basemap });
    h.loadImage();
    expect(h.get("map").innerHTML).toContain("/cast/basemap?v=1");
    expect(h.get("map").innerHTML).toContain('cx="300" cy="240"');
    h.render({
      basemap,
      frame: { ...frame, sequence: 2, position: { ...frame.position, lon: frame.position.lon + 0.001 } }
    });
    expect(h.get("map").innerHTML).toMatch(/cx="346\.60/);
    h.render({ basemap, stale: true });
    expect(h.get("map").innerHTML).toContain("/cast/basemap?v=1");
    expect(h.get("map").innerHTML).toContain("上次位置");
    expect(h.get("map").hidden).toBe(false);
    h.render({ connected: false, frame: null, basemap: null });
    expect(h.get("map-panel").hidden).toBe(true);
  });

  it("shows the native phone map only after loading, and falls back when GPS or images expire", () => {
    const h = harness();
    h.render({ mapSequence: 1 });
    expect(h.get("phone-map").hidden).toBe(true);
    h.get("phone-map").onload!();
    expect(h.get("phone-map").hidden).toBe(false);
    expect(h.get("map").hidden).toBe(true);
    expect(h.get("camera").hidden).toBe(true);
    h.render({ mapSequence: 2, stale: true });
    expect(h.get("phone-map").hidden).toBe(true);
    expect(h.get("map").hidden).toBe(false);
    h.render({ mapSequence: 3 });
    h.get("phone-map").onerror!();
    expect(h.get("map").hidden).toBe(false);
    h.render({ mapSequence: null });
    expect(h.get("camera").hidden).toBe(false);
  });

  it("keeps old phones compatible and labels last-known position on stale GPS", () => {
    const h = harness();
    h.render({ frame: { ...frame, turns: undefined } });
    expect(h.get("upcoming-panel").hidden).toBe(true);
    h.render({ stale: true });
    expect(h.get("distance").textContent).toBe("等待更新");
    expect(h.get("map").innerHTML).toContain("上次位置");
    expect(h.get("map").innerHTML).not.toContain('fill="#63d8ff"');
    expect(h.get("arrival").textContent).toBe("—");
    expect(h.get("upcoming-panel").hidden).toBe(true);
  });
  it("anchors arrival time to a fresh frame instead of drifting on every poll", () => {
    const h = harness();
    h.render();
    const arrival = h.value("arrivalAt");
    h.advance();
    h.render();
    expect(h.value("arrivalAt")).toBe(arrival);
    h.render({ frame: { ...frame, sequence: 2 } });
    expect(h.value("arrivalAt")).toBe(arrival + 60_000);
    h.render({ frame: null, connected: false });
    expect(h.get("map-panel").hidden).toBe(true);
    expect(h.value("arrivalAt")).toBe(null);
  });
  it("does not interpret phone text as markup", () => {
    const h = harness();
    h.render({ frame: { ...frame, instruction: '<img src=x onerror="alert(1)">' } });
    expect(h.get("instruction").textContent).toContain("<img");
    expect(h.get("map").innerHTML).not.toContain("onerror");
  });
});
