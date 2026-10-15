import { describe, expect, it } from "vitest";
import { persistEvidence } from "../scripts/synthetic-qa/browser/evidence";
import { closeForSyntheticOutage } from "../scripts/synthetic-qa/browser/outage";
import { IDLE_CLOSE_CODE } from "../shared/agent";
import {
  assertBackgroundQuiet,
  findHazardInterruption,
  findHazardWarningStart,
  assertFullPcmLifecycle,
  assertDisconnected,
  hasProviderReplyCompletion,
  isProviderReplyDrained,
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
  it("requires rendered, independently verified canonical warning audio after the exact PCM cut", () => {
    const hash = "a".repeat(64);
    const warning = {
      ...hazard,
      event: { type: "hazard.alert", interrupt: true, message: "Brake", advice: "Slow down" }
    };
    const events = [
      warning,
      observation("playback.stop", { sourceId: 1 }),
      observation("playback.stop", { sourceId: 2 }),
      observation("warning.audio.scheduled", {
        sourceId: 3,
        text: "Brake Slow down",
        state: "running",
        pcmSha256: hash
      }),
      observation("warning.audio.verified", { sourceId: 3, pcmSha256: hash, matchesManifest: true }, 1010),
      observation("warning.audio.rendered", { sourceId: 3, peak: 0.2, state: "running" }, 1020)
    ];
    expect(findHazardWarningStart(events)).toEqual({ hazardAt: 1000, warningSourceId: 3 });
    expect(findHazardWarningStart(events.slice(0, -1))).toBeNull();
    expect(findHazardWarningStart(events.filter((x) => x.type !== "warning.audio.verified"))).toBeNull();
    expect(
      findHazardWarningStart(
        events.map((x) => (x.type === "warning.audio.verified" ? { ...x, matchesManifest: false } : x))
      )
    ).toBeNull();
    expect(
      findHazardWarningStart(
        events.map((x) => (x.type === "warning.audio.scheduled" ? { ...x, text: "Wrong advice" } : x))
      )
    ).toBeNull();
    expect(
      findHazardWarningStart([
        ...events.slice(0, -1),
        observation("warning.audio.stop", { sourceId: 3 }, 1015),
        events.at(-1)!
      ])
    ).toBeNull();
    expect(
      findHazardWarningStart([
        ...events.slice(0, -1),
        observation("warning.audio.ended", { sourceId: 3 }, 1015),
        events.at(-1)!
      ])
    ).toBeNull();
    expect(
      findHazardWarningStart(events.map((x) => (x.type === "warning.audio.rendered" ? { ...x, peak: 0 } : x)))
    ).toBeNull();
  });
  const providerCompleted = observation("relay.event", {
    event: { type: "status", state: "ready", detail: "豆包回复已完成" }
  });
  it("allows a continuing ADAS warning before stop but never a pending provider buffer", () => {
    const warningOnly = { ...silent, active: 1, activeSourceIds: [3], activeProviderSourceIds: [] };
    expect(isProviderReplyDrained([...normal, providerCompleted], warningOnly, 2000, true)).toBe(true);
    expect(isProviderReplyDrained([...normal, providerCompleted], warningOnly, 2000, false)).toBe(false);
    expect(
      isProviderReplyDrained(
        [...normal, providerCompleted],
        { ...warningOnly, activeProviderSourceIds: [3] },
        2000,
        true
      )
    ).toBe(false);
    expect(
      findHazardInterruption([
        { ...hazard, playbackBefore: warningOnly },
        observation("warning.audio.stop", { sourceId: 3 })
      ])
    ).toBeNull();
  });
  it("does not mistake hazard final captions or completed text for provider audio completion", () => {
    const caption = observation("relay.event", {
      event: { type: "transcript", speaker: "agent", final: true, text: "[后方] 注意，后方车辆高速接近。" }
    });
    const textCompleted = observation("relay.event", {
      event: { type: "status", state: "ready", detail: "豆包回复文本已完成" }
    });
    expect(isProviderReplyDrained([...normal, caption, textCompleted], silent, 2000, true)).toBe(false);
    expect(isProviderReplyDrained(normal, silent, 2000)).toBe(false);
  });
  it("permits ongoing ADAS warning speech only after provider completion and a full PCM quiet interval", () => {
    const events = [...normal, providerCompleted];
    const warningSpeaking = { ...silent, browserSpeaking: true };
    expect(isProviderReplyDrained(events, warningSpeaking, 2000, true)).toBe(true);
    expect(isProviderReplyDrained(events, warningSpeaking, 2000)).toBe(false);
    expect(isProviderReplyDrained(events, silent, 1999, true)).toBe(false);
    expect(isProviderReplyDrained(events, { ...silent, active: 1, activeSourceIds: [1] }, 2000, true)).toBe(false);
    expect(isProviderReplyDrained([providerCompleted], silent, 2000, true)).toBe(false);
  });
  it("rejects degraded completion and an earlier exchange outside the current response window", () => {
    const degraded = observation("relay.event", {
      event: { type: "status", state: "degraded", detail: "网络拥塞，本轮语音未完整播放" }
    });
    expect(isProviderReplyDrained([...normal, degraded], silent, 2000, true)).toBe(false);
    const twoExchanges = [...normal, providerCompleted, ...normal];
    expect(isProviderReplyDrained(twoExchanges.slice(4), silent, 2000, true)).toBe(false);
  });
  it("requires the provider PCM completion marker and resets quiet time for late PCM", () => {
    expect(hasProviderReplyCompletion([providerCompleted])).toBe(true);
    expect(
      hasProviderReplyCompletion([
        observation("relay.event", { event: { type: "status", state: "speaking", detail: "豆包回复已完成" } }),
        observation("relay.event", { event: { type: "transcript", speaker: "agent", final: true, text: "我在。" } })
      ])
    ).toBe(false);
    const late = [
      ...normal,
      providerCompleted,
      observation("audio.received", { bytes: 960 }, 2100),
      observation("playback.start", { sourceId: 2, samples: 480, state: "running" }, 2100),
      observation("playback.ended", { sourceId: 2, interrupted: false }, 2200)
    ];
    expect(isProviderReplyDrained(late, silent, 3099, true)).toBe(false);
    expect(isProviderReplyDrained(late, silent, 3100, true)).toBe(true);
    expect(() => assertFullPcmLifecycle(late, true)).not.toThrow();
    expect(() =>
      assertFullPcmLifecycle([...late.slice(0, -1), observation("playback.stop", { sourceId: 2 }, 2200)], true)
    ).toThrow("PCM source 2 never finished");
  });
  it.each([
    { hazardAt: 1791970713257, firstLateAt: 1791970713312, disconnectAt: 1791970713575, ids: [89, 90, 91, 92, 93] },
    { hazardAt: 1791970892837, firstLateAt: 1791970892883, disconnectAt: 1791970893178, ids: [306, 307, 308, 309] }
  ])("rechecks late PCM cut by ordinary teardown in the saved 8dd ADAS pattern $ids", (record) => {
    const beforeStop = [
      ...normal.slice(0, 2),
      observation(
        "relay.event",
        {
          event: { type: "hazard.alert", interrupt: true },
          playbackBefore: { ...silent, active: 1, activeSourceIds: [1] }
        },
        record.hazardAt
      ),
      observation("playback.stop", { sourceId: 1 }, record.hazardAt),
      observation(
        "relay.event",
        {
          event: { type: "transcript", speaker: "agent", final: true, text: "[左后方] 保持车道。" }
        },
        record.hazardAt
      )
    ];
    expect(() => assertFullPcmLifecycle(beforeStop, true)).not.toThrow();
    expect(isProviderReplyDrained(beforeStop, silent, record.hazardAt, true)).toBe(false);
    const fullSavedLifecycle = [
      ...beforeStop,
      ...record.ids.flatMap((sourceId, index) => [
        observation("audio.received", { bytes: 16384 }, record.firstLateAt + index),
        observation("playback.start", { sourceId, samples: 8192, state: "running" }, record.firstLateAt + index),
        observation("playback.stop", { sourceId }, record.disconnectAt)
      ])
    ];
    expect(() => assertFullPcmLifecycle(fullSavedLifecycle, true)).toThrow(
      `PCM source ${record.ids[0]} never finished`
    );
  });
  it("credits a hazard warning only when its exact utterance actually starts", () => {
    const warning = {
      ...hazard,
      event: { type: "hazard.alert", interrupt: true, message: "Brake", advice: "Slow down" }
    };
    const events = [
      warning,
      observation("playback.stop", { sourceId: 1 }),
      observation("playback.stop", { sourceId: 2 }),
      observation("speech.request", { utteranceId: 9, text: "Brake Slow down" }),
      observation("speech.start", { utteranceId: 9, text: "Brake Slow down" }, 1200)
    ];
    expect(findHazardWarningStart(events)).toEqual({ hazardAt: 1000, utteranceId: 9 });
    expect(findHazardWarningStart(events.slice(0, -1))).toBeNull();
    expect(
      findHazardWarningStart([...events.slice(0, -1), observation("speech.start", { utteranceId: 10 })])
    ).toBeNull();
    expect(
      findHazardWarningStart([warning, observation("relay.event", { event: { type: "status" } }), ...events.slice(1)])
    ).toBeNull();
  });
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
