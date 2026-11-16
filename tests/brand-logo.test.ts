import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assistantLogo,
  assistantProfileFrom,
  assistantSummary,
  brandLogoFrom,
  setAssistantProfileForTests
} from "../server/assistant";
import { DEVICE_PRESETS } from "../server/device-presets";
import { ANDROID_FOREGROUNDS, androidLogoSize, resolveBrandSource } from "../scripts/brand";

afterEach(() => setAssistantProfileForTests());

describe("device logos", () => {
  it("ships a mark for every device preset", () => {
    for (const preset of DEVICE_PRESETS) {
      const file = path.resolve("brand/devices", `${preset.id}.svg`);
      const svg = fs.readFileSync(file, "utf8");
      expect(svg).toContain('viewBox="0 0 64 64"');
      // A logo is served on the relay's origin: it must be a plain drawing.
      expect(svg).not.toMatch(/<script|onload=|href=|<foreignObject/i);
    }
  });

  it("shows a helmet for a helmet and glasses for glasses", () => {
    expect(assistantLogo()?.path).toMatch(/brand\/devices\/motorcycle-helmet\.svg$/);
    expect(assistantSummary(true).logoUrl).toMatch(/^\/brand\/logo\?v=[a-z0-9]+$/);
    const glasses = assistantProfileFrom({ name: "Nova", device: "sunglasses" });
    expect(assistantLogo(glasses)?.path).toMatch(/brand\/devices\/sunglasses\.svg$/);
    expect(assistantLogo(assistantProfileFrom({ name: "Vee", device: "vr" }))?.path).toMatch(/vr-headset\.svg$/);
  });
});

describe("owner logo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brand-test-"));
  fs.writeFileSync(path.join(dir, "mark.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a logo");
  fs.writeFileSync(path.join(dir, "huge.png"), Buffer.alloc(600 * 1024));

  it("overrides the device mark, relative to the config file", () => {
    const profile = assistantProfileFrom(
      { name: "Nova", device: "sunglasses", logo: "./mark.svg", logoBackground: "#ffffff" },
      dir
    );
    expect(assistantLogo(profile)).toMatchObject({ path: path.join(dir, "mark.svg"), contentType: "image/svg+xml" });
    expect(profile.logoBackground).toBe("#FFFFFF");
  });

  it("refuses anything that is not a readable, reasonably sized SVG or PNG", () => {
    expect(brandLogoFrom("./notes.txt", dir).problem).toMatch(/\.svg or \.png/);
    expect(brandLogoFrom("./missing.svg", dir).problem).toMatch(/cannot be read/);
    expect(brandLogoFrom("./huge.png", dir).problem).toMatch(/larger than/);
    expect(brandLogoFrom("../../etc/passwd", dir).logo).toBeUndefined();
    expect(brandLogoFrom(undefined, dir)).toEqual({});
    // A rejected logo falls back to the device's mark rather than no mark.
    const profile = assistantProfileFrom({ name: "Nova", device: "sunglasses", logo: "./notes.txt" }, dir);
    expect(assistantLogo(profile)?.path).toMatch(/sunglasses\.svg$/);
  });
});

describe("icon generator", () => {
  it("picks the logo from the argument, then the config, then the device", () => {
    const cwd = "/repo";
    expect(resolveBrandSource("art/mine.svg", JSON.stringify({ logo: "x.svg" }), cwd).file).toBe("/repo/art/mine.svg");
    expect(resolveBrandSource(undefined, JSON.stringify({ logo: "x.svg", logoBackground: "#123abc" }), cwd)).toEqual({
      file: "/repo/x.svg",
      background: "#123ABC"
    });
    expect(resolveBrandSource(undefined, JSON.stringify({ device: "assistive" }), cwd).file).toBe(
      "/repo/brand/devices/assistive-glasses.svg"
    );
    expect(resolveBrandSource(undefined, undefined, cwd)).toEqual({
      file: "/repo/brand/devices/motorcycle-helmet.svg",
      background: "#0B0C0E"
    });
    expect(resolveBrandSource(undefined, "{not json", cwd).file).toBe("/repo/brand/devices/motorcycle-helmet.svg");
  });

  it("keeps the Android logo inside the launcher's safe zone at every density", () => {
    expect(ANDROID_FOREGROUNDS.map(([, pixels]) => pixels)).toEqual([108, 162, 216, 324, 432]);
    expect(androidLogoSize(108)).toBe(66);
    expect(androidLogoSize(432)).toBe(264);
    // The built-in marks carry their own margin and are drawn larger.
    expect(androidLogoSize(108, true)).toBe(92);
  });
});
