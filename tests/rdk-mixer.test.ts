import { describe, expect, it } from "vitest";
import {
  CROSSTALK_AEC_OFF,
  CROSSTALK_AEC_ON,
  applyCrosstalk,
  crosstalkFor,
  mixerArgs
} from "../rdk/agent/src/audio/mixer";

describe("crosstalkFor", () => {
  it("disables the hardware duck when AEC is active", () => {
    expect(crosstalkFor(true)).toBe(CROSSTALK_AEC_ON);
    expect(CROSSTALK_AEC_ON).toBe(0);
  });

  it("restores the vendor duck when AEC is not active", () => {
    // The duck is the only thing preventing the echo loop without a canceller.
    expect(crosstalkFor(false)).toBe(CROSSTALK_AEC_OFF);
    expect(CROSSTALK_AEC_OFF).toBe(10);
  });
});

describe("mixerArgs", () => {
  it("targets card 0 and the named control", () => {
    expect(mixerArgs("CROSSTALK1", 0)).toEqual(["-c", "0", "sset", "CROSSTALK1", "0"]);
  });
});

describe("applyCrosstalk", () => {
  it("sets both crosstalk controls", async () => {
    const calls: string[][] = [];
    const ok = await applyCrosstalk(true, async (_cmd, args) => {
      calls.push(args);
      return 0;
    });
    expect(ok).toBe(true);
    expect(calls.map((a) => a[3])).toEqual(["CROSSTALK1", "CROSSTALK2"]);
    expect(calls.every((a) => a[4] === "0")).toBe(true);
  });

  it("writes 10 to both when AEC is off", async () => {
    const values: string[] = [];
    await applyCrosstalk(false, async (_cmd, args) => {
      values.push(args[4]!);
      return 0;
    });
    expect(values).toEqual(["10", "10"]);
  });

  it("reports failure when amixer exits non-zero", async () => {
    expect(await applyCrosstalk(true, async () => 1)).toBe(false);
  });

  it("reports failure rather than throwing when amixer is missing", async () => {
    expect(
      await applyCrosstalk(true, async () => {
        throw new Error("ENOENT");
      })
    ).toBe(false);
  });
});
