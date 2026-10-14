import { describe, expect, it } from "vitest";
import { persistEvidence } from "../scripts/synthetic-qa/browser/evidence";
import { closeForSyntheticOutage } from "../scripts/synthetic-qa/browser/outage";
import { IDLE_CLOSE_CODE } from "../shared/agent";
import {
  assertBackgroundQuiet,
  findHazardInterruption,
  assertFullPcmLifecycle,
  assertDisconnected,
  type Observation,
  type PlaybackSnapshot
} from "../scripts/synthetic-qa/browser/assertions";
const silent: PlaybackSnapshot = { active: 0, activeSourceIds: [], browserSpeaking: false, contextState: "closed" };
const observation = (type: string, fields: Record<string, unknown> = {}, at = 1000): Observation => ({
  at,
  type,
  ...fields
});
const normal = [
  observation("audio.received", { bytes: 960 }),
  observation("playback.start", { sourceId: 1, samples: 480, state: "running" }),
  observation("playback.ended", { sourceId: 1, interrupted: false })
];
const hazard = observation("relay.event", {
  event: { type: "hazard.alert", interrupt: true },
  playbackBefore: { ...silent, active: 2, activeSourceIds: [1, 2] }
});
describe("synthetic browser behavior assertions", () => {
  it("simulates an unexpected outage instead of the terminal relay idle close", () => {
    let code: number | undefined;
    closeForSyntheticOutage({
      close: (value) => {
        code = value;
      }
    });
    expect(code).not.toBe(IDLE_CLOSE_CODE);
    expect(code).toBeGreaterThanOrEqual(3000);
    expect(code).toBeLessThanOrEqual(4999);
  });
  it("rejects evidence save failures instead of reporting a saved pass", async () => {
    const request = (response: Response) => (async () => response) as typeof fetch;
    await expect(persistEvidence({}, request(new Response("saved")))).resolves.toBeUndefined();
    await expect(persistEvidence({}, request(new Response("invalid", { status: 400 })))).rejects.toThrow("not saved");
    await expect(persistEvidence({}, request(new Response("unexpected")))).rejects.toThrow("not saved");
  });
  it("rejects an unaddressed PCM or speech response even without agent transcript", () => {
    expect(() => assertBackgroundQuiet([observation("audio.received", { bytes: 960 })], silent)).toThrow("unaddressed");
    expect(() => assertBackgroundQuiet([observation("speech.start")], silent)).toThrow("unaddressed");
    expect(() => assertBackgroundQuiet([], { ...silent, active: 1, activeSourceIds: [1] })).toThrow("pending");
  });
  it("rejects agent text without PCM in the background window", () => {
    expect(() =>
      assertBackgroundQuiet([observation("relay.event", { event: { type: "transcript", speaker: "agent" } })], silent)
    ).toThrow("unaddressed");
    expect(() =>
      assertBackgroundQuiet([observation("relay.event", { event: { type: "transcript", speaker: "rider" } })], silent)
    ).not.toThrow();
  });
  it("requires all pending source IDs to stop directly after an interrupting hazard", () => {
    expect(
      findHazardInterruption([
        hazard,
        observation("playback.stop", { sourceId: 1 }),
        observation("playback.stop", { sourceId: 2 })
      ])
    ).toEqual({ hazardAt: 1000, stoppedSourceIds: [1, 2] });
    expect(
      findHazardInterruption([
        observation("playback.stop", { sourceId: 1 }),
        hazard,
        observation("playback.stop", { sourceId: 2 })
      ])
    ).toBeNull();
    expect(
      findHazardInterruption([
        hazard,
        observation("playback.stop", { sourceId: 1 }),
        observation("relay.event", { event: { type: "status" } }),
        observation("playback.stop", { sourceId: 2 })
      ])
    ).toBeNull();
  });
  it("rejects a hazard that arrived while PCM was silent and unrelated later stops", () => {
    expect(
      findHazardInterruption([
        observation("relay.event", { event: { type: "hazard.alert", interrupt: true }, playbackBefore: silent }),
        observation("playback.stop", { sourceId: 1 })
      ])
    ).toBeNull();
    expect(
      findHazardInterruption([
        hazard,
        observation("playback.stop", { sourceId: 1 }, 2500),
        observation("playback.stop", { sourceId: 2 }, 2500)
      ])
    ).toBeNull();
  });
  it("requires all received samples to play naturally for a normal reply", () => {
    expect(() => assertFullPcmLifecycle(normal)).not.toThrow();
    expect(() => assertFullPcmLifecycle(normal.slice(0, 2))).toThrow("never finished");
    expect(() => assertFullPcmLifecycle([normal[0]!, { ...normal[1]!, samples: 479 }, normal[2]!])).toThrow(
      "truncated"
    );
    expect(() => assertFullPcmLifecycle([normal[0]!])).toThrow("Not every");
  });
  it("permits the asserted ADAS interruption but rejects the same truncation for normal replies", () => {
    const interrupted = [
      ...normal.slice(0, 2),
      observation("relay.event", {
        event: { type: "hazard.alert", interrupt: true },
        playbackBefore: { ...silent, active: 1, activeSourceIds: [1] }
      }),
      observation("playback.stop", { sourceId: 1 }),
      observation("playback.ended", { sourceId: 1, interrupted: true })
    ];
    expect(() => assertFullPcmLifecycle(interrupted, true)).not.toThrow();
    expect(() => assertFullPcmLifecycle(interrupted)).toThrow("naturally");
    expect(() =>
      assertFullPcmLifecycle(
        interrupted.filter((item) => item.type !== "relay.event"),
        true
      )
    ).toThrow();
    expect(() =>
      assertFullPcmLifecycle(
        [
          ...interrupted,
          observation("audio.received", { bytes: 960 }),
          observation("playback.start", { sourceId: 2, samples: 480, state: "running" }),
          observation("playback.stop", { sourceId: 2 })
        ],
        true
      )
    ).toThrow();
  });
  it("fails silent or permanently suspended audio instead of treating transcript as playback", () => {
    expect(() => assertFullPcmLifecycle([])).toThrow("PCM");
    expect(() =>
      assertFullPcmLifecycle(
        normal.map((item) => (item.type === "playback.start" ? { ...item, state: "suspended" } : item))
      )
    ).toThrow("never ran");
  });
  it("requires closed audio context, no queued PCM and no speech after disconnect", () => {
    expect(() =>
      assertDisconnected({ captureActive: false, listening: false, connection: "offline", playback: silent })
    ).not.toThrow();
    expect(() =>
      assertDisconnected({ captureActive: true, listening: false, connection: "offline", playback: silent })
    ).toThrow("active");
    expect(() =>
      assertDisconnected({
        captureActive: false,
        listening: false,
        connection: "offline",
        playback: { ...silent, active: 1 }
      })
    ).toThrow("active");
    expect(() =>
      assertDisconnected({
        captureActive: false,
        listening: false,
        connection: "offline",
        playback: { ...silent, browserSpeaking: true }
      })
    ).toThrow("active");
    expect(() =>
      assertDisconnected({
        captureActive: false,
        listening: false,
        connection: "offline",
        playback: { ...silent, contextState: "running" }
      })
    ).toThrow("active");
  });
});
