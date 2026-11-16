import { readdirSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LanguageProvider } from "../src/components/LanguageToggle";
import { LandingPage } from "../src/landing/LandingPage";
import { DEVICES } from "../src/lib/device-catalog";
import { REPOSITORY_URL, resolveRoute } from "../src/lib/routes";
import { demoFrame, scriptForDevice, scriptLength } from "../src/lib/scripted-demo";

const at = (pathname: string, hash = "", search = "") => resolveRoute({ pathname, hash, search });

describe("top-level routing", () => {
  it("shows the landing page at / and anything unknown", () => {
    expect(at("/")).toEqual({ surface: "landing" });
    expect(at("")).toEqual({ surface: "landing" });
    expect(at("/nope")).toEqual({ surface: "landing" });
    expect(at("/", "#demo")).toEqual({ surface: "landing" });
  });

  it("shows the app under /app, hash routes included", () => {
    expect(at("/app")).toEqual({ surface: "app" });
    expect(at("/app/")).toEqual({ surface: "app" });
    expect(at("/app", "#/admin/studio")).toEqual({ surface: "app" });
    expect(at("/application")).toEqual({ surface: "landing" });
  });

  it("shows the configurator at /build", () => {
    expect(at("/build")).toEqual({ surface: "build" });
    expect(at("/build/")).toEqual({ surface: "build" });
  });

  it("sends a pre-landing-page workspace bookmark to the same hash under /app", () => {
    expect(at("/", "#/admin/accounts")).toEqual({ surface: "app", redirect: "/app#/admin/accounts" });
    expect(at("/", "#/testing/evidence?session=abc", "?token=t")).toEqual({
      surface: "app",
      redirect: "/app?token=t#/testing/evidence?session=abc"
    });
    expect(at("/", "#/testing")).toEqual({ surface: "app", redirect: "/app#/testing" });
    expect(at("/", "#/administrator")).toEqual({ surface: "landing" });
  });
});

describe("device marks", () => {
  it("are byte-for-byte the repo's brand/devices files", () => {
    const brand = new URL("../brand/devices/", import.meta.url);
    const copies = new URL("../src/assets/device-marks/", import.meta.url);
    const files = readdirSync(brand).filter((file) => file.endsWith(".svg"));
    expect(files.sort()).toEqual(DEVICES.map((device) => `${device.id}.svg`).sort());
    for (const file of files) {
      expect(readFileSync(new URL(file, copies), "utf8"), file).toBe(readFileSync(new URL(file, brand), "utf8"));
    }
  });
});

describe("scripted demo", () => {
  it("plays a conversation with a safety alert and a device action for every device", () => {
    for (const device of DEVICES) {
      const script = scriptForDevice(device.id);
      const frames = Array.from({ length: scriptLength(script) }, (_, beat) => demoFrame(script, beat));
      expect(frames[0]).toMatchObject({ phase: "idle", captions: [], hazard: null, action: null });
      expect(frames.some((frame) => frame.hazard)).toBe(true);
      expect(frames.some((frame) => frame.action)).toBe(true);
      expect(frames.some((frame) => frame.phase === "thinking")).toBe(true);
      expect(frames.some((frame) => frame.phase === "speaking")).toBe(true);
      expect(frames.every((frame) => frame.captions.length <= 4)).toBe(true);
      // It loops: the beat after the last is the opening again.
      expect(demoFrame(script, scriptLength(script))).toEqual(frames[0]);
    }
    expect(scriptForDevice("assistive-glasses")).toBe("assistive");
    expect(scriptForDevice("bicycle-helmet")).toBe("helmet");
    expect(scriptForDevice("vr-headset")).toBe("headset");
    expect(scriptForDevice("sunglasses")).toBe("glasses");
  });
});

describe("landing page", () => {
  const render = (signedIn: boolean) =>
    renderToStaticMarkup(
      <LanguageProvider>
        <LandingPage signedIn={signedIn} />
      </LanguageProvider>
    );

  it("says what it is, offers the demo and the configurator, and labels the demo as scripted", () => {
    const html = render(false);
    expect(html).toContain('href="#demo"');
    expect(html).toContain('href="/build"');
    expect(html).toContain("脚本预览");
    for (const id of ["demo", "devices", "backends", "look", "how", "start"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("npm run setup");
  });

  it("turns the primary action into Open the app for a signed-in visitor", () => {
    const html = render(true);
    expect(html).toMatch(/class="siteButton" href="\/app"/);
  });

  it("lists every device and both kinds of backend", () => {
    const html = render(false);
    for (const device of DEVICES) expect(html).toContain(device.label.zh);
    for (const name of ["Doubao Realtime", "OpenAI Realtime", "Grok Voice", "Gemini Live", "Local models"]) {
      expect(html).toContain(name);
    }
  });

  it("links the repository only once there is one", () => {
    expect(REPOSITORY_URL).toBe("");
    expect(render(false)).not.toContain("GitHub");
  });
});
