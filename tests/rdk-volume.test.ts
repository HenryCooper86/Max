import { describe, expect, it, vi } from "vitest";
import { getAlsaVolume, parsePlaybackLevel, setAlsaVolume } from "../rdk/agent/src/audio/volume";

/** What `amixer -c 0 get Playback` prints with the mixer at its ceiling. */
const AT_CEILING = [
  "Simple mixer control 'Playback',0",
  "  Capabilities: pvolume",
  "  Playback channels: Front Left - Front Right",
  "  Limits: Playback 0 - 255",
  "  Mono:",
  "  Front Left: Playback 255 [100%] [0.00dB]",
  "  Front Right: Playback 255 [100%] [0.00dB]",
  ""
].join("\n");

const AT_72 = AT_CEILING.replace(/\[100%\] \[0\.00dB\]/g, "[72%] [on]");

describe("parsePlaybackLevel", () => {
  it("reads the level amixer prints, as a fraction", () => {
    expect(parsePlaybackLevel(AT_CEILING)).toBe(1);
    // Whatever amixer prints after the percent (dB, a switch) is not the level.
    expect(parsePlaybackLevel(AT_72)).toBe(0.72);
    expect(parsePlaybackLevel(AT_CEILING.replace(/\[100%\] \[0\.00dB\]/g, "[0%]"))).toBe(0);
  });

  it("reads a mono control too", () => {
    const mono = [
      "Simple mixer control 'Playback',0",
      "  Capabilities: pvolume pswitch",
      "  Playback channels: Mono",
      "  Limits: Playback 0 - 31",
      "  Mono: Playback 20 [65%] [on]",
      ""
    ].join("\n");
    expect(parsePlaybackLevel(mono)).toBe(0.65);
  });

  it("returns null for output that holds no playback level", () => {
    expect(parsePlaybackLevel("")).toBeNull();
    expect(parsePlaybackLevel("amixer: Unable to find simple control 'Playback',0\n")).toBeNull();
    // The header and the limits line name Playback too; neither is a level.
    expect(parsePlaybackLevel("Simple mixer control 'Playback',0\n  Limits: Playback 0 - 255\n")).toBeNull();
  });
});

describe("ALSA playback volume", () => {
  it("reads the card's Playback control and reports its level", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: AT_72 }));
    await expect(getAlsaVolume("plughw:0,0", run)).resolves.toBe(0.72);
    expect(run).toHaveBeenCalledWith(["-c", "0", "get", "Playback"]);
  });

  it("takes the card from the device name", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: AT_CEILING }));
    await getAlsaVolume("hw:2,0", run);
    expect(run).toHaveBeenCalledWith(["-c", "2", "get", "Playback"]);
  });

  it("resolves null when amixer fails, so a step is never taken from a guess", async () => {
    const missing = "amixer: Unable to find simple control 'Playback',0\n";
    await expect(getAlsaVolume("plughw:0,0", async () => ({ code: 1, stdout: missing }))).resolves.toBeNull();
    // code null: amixer could not be started at all.
    await expect(getAlsaVolume("plughw:0,0", async () => ({ code: null, stdout: "" }))).resolves.toBeNull();
  });

  it("writes the level as whole percents of the same control", async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: "" }));
    await expect(setAlsaVolume("plughw:0,0", 4 / 7, run)).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith(["-c", "0", "sset", "Playback", "57%"]);
  });

  it("clamps what it writes, and reports a mixer that would not take it", async () => {
    const run = vi.fn(async () => ({ code: 1, stdout: "" }));
    await expect(setAlsaVolume("plughw:0,0", 1.5, run)).resolves.toBe(false);
    expect(run).toHaveBeenCalledWith(["-c", "0", "sset", "Playback", "100%"]);
  });
});
