import { describe, expect, it } from "vitest";
import { createVisionGovernor, type WatchDropReason } from "../server/vision-governor";
import { WATCH_PROMPT } from "../server/vision";

function harness(overrides: Partial<Parameters<typeof createVisionGovernor>[0]> = {}) {
  const drops: WatchDropReason[] = [];
  const spoken: string[] = [];
  const described: Array<{ frames: string[]; question?: string }> = [];
  let clock = 0;
  let speechOpen = false;
  let answer: string | null = "前方有慢车。";
  const governor = createVisionGovernor({
    describe: async (frames, question) => {
      described.push({ frames, question });
      return answer;
    },
    speak: (line) => spoken.push(line),
    isSpeechOpen: () => speechOpen,
    onDrop: (reason) => drops.push(reason),
    now: () => clock,
    ...overrides
  });
  return {
    governor,
    drops,
    spoken,
    described,
    setClock: (t: number) => (clock = t),
    setSpeechOpen: (v: boolean) => (speechOpen = v),
    setAnswer: (a: string | null) => (answer = a)
  };
}

describe("createVisionGovernor", () => {
  it("drops disabled frames — off by default", async () => {
    const h = harness();
    await h.governor.handleWatchFrame("F");
    expect(h.drops).toEqual(["disabled"]);
    expect(h.described).toHaveLength(0);
  });

  it("speaks a notable observation with the watch prompt", async () => {
    const h = harness();
    h.governor.setEnabled(true);
    await h.governor.handleWatchFrame("F");
    expect(h.described).toEqual([{ frames: ["F"], question: WATCH_PROMPT }]);
    expect(h.spoken).toEqual(["前方有慢车。"]);
    expect(h.drops).toEqual([]);
  });

  it("enforces the 2 min cooldown after speaking", async () => {
    const h = harness();
    h.governor.setEnabled(true);
    await h.governor.handleWatchFrame("A");
    h.setClock(60_000);
    await h.governor.handleWatchFrame("B");
    expect(h.drops).toEqual(["cooldown"]);
    h.setClock(121_000);
    await h.governor.handleWatchFrame("C");
    expect(h.spoken).toHaveLength(2);
  });

  it("drops inside the 30 s ADAS window", async () => {
    const h = harness();
    h.governor.setEnabled(true);
    h.governor.noteHazard();
    h.setClock(29_000);
    await h.governor.handleWatchFrame("F");
    expect(h.drops).toEqual(["adas-window"]);
    h.setClock(31_000);
    await h.governor.handleWatchFrame("F");
    expect(h.spoken).toHaveLength(1);
  });

  it("drops while speech is open — never queues", async () => {
    const h = harness();
    h.governor.setEnabled(true);
    h.setSpeechOpen(true);
    await h.governor.handleWatchFrame("F");
    expect(h.drops).toEqual(["speech"]);
    h.setSpeechOpen(false);
    expect(h.spoken).toHaveLength(0); // nothing replays later
  });

  it("caps model calls at 40 per rolling hour", async () => {
    const h = harness({ cooldownMs: 0 });
    h.governor.setEnabled(true);
    for (let call = 0; call < 40; call += 1) {
      h.setClock(call * 1000);
      await h.governor.handleWatchFrame("F");
    }
    expect(h.described).toHaveLength(40);
    await h.governor.handleWatchFrame("F");
    expect(h.drops).toEqual(["budget"]);
    h.setClock(3_601_000); // first call ages out of the rolling window
    await h.governor.handleWatchFrame("F");
    expect(h.described).toHaveLength(41);
  });

  it("separates nothing-notable from model failure", async () => {
    const h = harness({ cooldownMs: 0 });
    h.governor.setEnabled(true);
    h.setAnswer("无。");
    await h.governor.handleWatchFrame("F");
    h.setAnswer(null);
    await h.governor.handleWatchFrame("F");
    expect(h.drops).toEqual(["nothing-notable", "model-failure"]);
    expect(h.spoken).toHaveLength(0);
  });

  it("rules apply in order — disabled wins over everything", async () => {
    const h = harness();
    h.governor.setEnabled(true);
    h.governor.setEnabled(false);
    h.governor.noteHazard();
    h.setSpeechOpen(true);
    await h.governor.handleWatchFrame("F");
    expect(h.drops).toEqual(["disabled"]);
  });

  it("detects in-flight describes and drops overlapping frames as speech", async () => {
    let resolveDescribe: (value: string) => void;
    const describePromise = new Promise<string>((resolve) => {
      resolveDescribe = resolve;
    });

    const h = harness({
      describe: async () => describePromise
    });
    h.governor.setEnabled(true);

    // Start first frame (will hang waiting for resolve)
    const firstFramePromise = h.governor.handleWatchFrame("A");

    // Deliver second frame while first is in flight
    await h.governor.handleWatchFrame("B");

    // Resolve the first describe
    resolveDescribe!("前方有慢车。");
    await firstFramePromise;

    // Exactly one speak (from first), one drop (speech) for second
    expect(h.spoken).toHaveLength(1);
    expect(h.drops).toEqual(["speech"]);
  });
});
