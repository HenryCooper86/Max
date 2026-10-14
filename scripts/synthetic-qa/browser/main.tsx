import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useHelmetAgent } from "../../../src/hooks/useHelmetAgent";
import { TESTING_TEST_CASES } from "../../../shared/testing";
import {
  observations,
  subscribe,
  observe,
  playFixture,
  injectOutage,
  resetObservations,
  currentPlayback,
  releaseSyntheticContext,
  preflightFixtures,
  setSyntheticCohort,
  currentCaptureResources
} from "./runtime";
import {
  assertBackgroundQuiet,
  findHazardInterruption,
  assertFullPcmLifecycle,
  assertDisconnected,
  type AssertionResult
} from "./assertions";
import "./style.css";
import { persistEvidence } from "./evidence";
const fixtureForCase: Record<string, string> = {
  "baseline-live-session": "baseline",
  "wake-word-addressed-only": "wake-addressed",
  "emergency-safe-guidance": "emergency",
  "adas-alert-interrupt": "adas",
  "wind-noise-robustness": "wind",
  "degraded-network-recovery": "network"
};
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
function App() {
  const agent = useHelmetAgent();
  const latest = useRef(agent);
  latest.current = agent;
  const cancelled = useRef(false);
  const assertions = useRef<AssertionResult[]>([]);
  const [selected, setSelected] = useState(TESTING_TEST_CASES[0].id);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("Ready. Synthetic audio only; real mic and location are bypassed.");
  const [results, setResults] = useState<Array<{ id: string; result: "pass" | "fail"; error?: string }>>([]);
  const [, rerender] = useState(0);
  useEffect(() => subscribe(() => rerender((value) => value + 1)), []);
  const hasEvent = (type: string) =>
    observations.some((item) => item.type === "relay.event" && (item.event as { type: string })?.type === type);
  async function until(test: () => boolean, timeout: number, label: string) {
    const started = Date.now();
    while (!test()) {
      if (cancelled.current) throw new Error("Synthetic run stopped by operator");
      if (Date.now() - started > timeout) throw new Error(`Timeout: ${label}`);
      await wait(100);
    }
  }
  function check(id: string, detail: string, verify: () => void) {
    try {
      verify();
      assertions.current.push({ id, status: "pass", detail });
      observe("assertion.pass", { id, detail });
    } catch (error) {
      assertions.current.push({ id, status: "fail", detail: String(error) });
      observe("assertion.fail", { id, detail: String(error) });
      throw error;
    }
  }
  async function waitForPlaybackDrain(label: string, since = 0) {
    await until(
      () => {
        const state = currentPlayback();
        const received = observations.slice(since).filter((item) => item.type === "audio.received");
        const last = received[received.length - 1];
        return !!last && Date.now() - last.at >= 1000 && state.active === 0 && !state.browserSpeaking;
      },
      45000,
      label
    );
  }
  async function save(id: string, result: "pass" | "fail", error?: string) {
    const context = await fetch("/qa-context").then((response) => response.json());
    const evidence = {
      id,
      result,
      error,
      assertions: [...assertions.current],
      testerId: latest.current.testerId,
      serverBuild: context.serverBuild,
      compiledClientCommit: context.compiledClientCommit,
      at: new Date().toISOString(),
      kind: "synthetic-browser-production-hooks",
      platform: "web",
      userAgent: navigator.userAgent,
      build: import.meta.env.VITE_GIT_COMMIT,
      productionHooks: ["useHelmetAgent", "useMicCapture", "useAudioPlayback"],
      captureBoundary: "PCM fixture -> AudioContext -> MediaStreamDestination -> production AudioWorklet",
      noRealMicrophone: true,
      noGeolocation: true,
      provider: latest.current.provider,
      state: {
        status: latest.current.status,
        connectionState: latest.current.connectionState,
        listening: latest.current.listening,
        packetStats: latest.current.packetStats,
        telemetry: latest.current.telemetry,
        transcript: latest.current.transcript,
        hazardAlert: latest.current.hazardAlert
      },
      playback: currentPlayback(),
      capture: currentCaptureResources(),
      observations: [...observations]
    };
    await persistEvidence(evidence);
    setResults((previous) => [...previous, evidence]);
    return evidence;
  }
  async function runCase(id: string) {
    setSelected(id);
    setProgress(`Running ${id}`);
    latest.current.disconnect();
    await releaseSyntheticContext();
    await wait(200);
    resetObservations();
    assertions.current = [];
    latest.current.clearTranscript();
    const context = await fetch("/qa-context").then((response) => response.json());
    latest.current.setTesterId(
      context.testerId ||
        `synthetic-web-${new Date()
          .toISOString()
          .replace(/[^0-9]/g, "")
          .slice(0, 14)}`
    );
    setSyntheticCohort(id, context);
    if (context.testingRunId && context.assignments?.[id])
      latest.current.setTestingAssignmentContext(context.testingRunId, context.assignments[id], id);
    else latest.current.setTestingTestCaseId(id);
    await latest.current.startMic();
    await until(() => hasEvent("session.started"), 20000, "provider session started");
    if (latest.current.provider !== "doubao") throw new Error(`Expected doubao, got ${latest.current.provider}`);
    if (id === "wake-word-addressed-only") {
      const backgroundStart = observations.length;
      const backgroundPlayback = currentPlayback();
      await playFixture("wake-background");
      await wait(4500);
      check("wake-background-quiet", "No agent transcript, PCM or speech during unaddressed audio", () => {
        assertBackgroundQuiet(observations.slice(backgroundStart), backgroundPlayback);
        if (latest.current.transcript.some((turn) => turn.speaker === "agent"))
          throw new Error("Agent transcript appeared during unaddressed background check");
      });
      observe("wake.background.result", {
        agentTurns: latest.current.transcript.filter((turn) => turn.speaker === "agent").length
      });
    }
    if (id === "degraded-network-recovery") {
      await playFixture("network");
      await until(
        () => latest.current.transcript.some((turn) => turn.speaker === "agent" && turn.final),
        22000,
        "first valid network exchange"
      );
      await waitForPlaybackDrain("first complete network PCM response");
      check("network-pre-outage-pcm", "First response fully played before planned outage", () =>
        assertFullPcmLifecycle(observations)
      );
      observe("network.before.outage", { transcript: [...latest.current.transcript] });
      injectOutage(4500);
      await until(
        () =>
          observations.filter(
            (item) => item.type === "relay.event" && (item.event as { type: string })?.type === "session.started"
          ).length >= 2,
        22000,
        "automatic reconnect provider ready"
      );
      observe("network.recovered", { state: latest.current.connectionState, listening: latest.current.listening });
    }
    const priorAgentTurns = latest.current.transcript.filter((turn) => turn.speaker === "agent" && turn.final).length;
    const responseStart = observations.length;
    await playFixture(fixtureForCase[id]!);
    await until(
      () => latest.current.transcript.filter((turn) => turn.speaker === "agent" && turn.final).length > priorAgentTurns,
      22000,
      "new final agent response"
    );
    if (id === "adas-alert-interrupt") {
      await until(() => findHazardInterruption(observations) !== null, 45000, "ADAS interruption of pending real PCM");
      check("adas-pcm-interruption", "Hazard interrupted every pending PCM source in the production handler", () => {
        if (!findHazardInterruption(observations)) throw new Error("No hazard correlated to pending PCM source stops");
      });
      await until(() => currentPlayback().active === 0, 20000, "ADAS PCM queue drained or interrupted");
    } else {
      await waitForPlaybackDrain("complete PCM response playback", responseStart);
    }
    check(
      "complete-pcm-lifecycle",
      "Every received PCM sample scheduled and every source completed or passed ADAS interruption",
      () => assertFullPcmLifecycle(observations, id === "adas-alert-interrupt")
    );
    observe("case.before.stop", { playback: currentPlayback() });
    latest.current.stopMic();
    await wait(300);
    observe("case.after.stop", { listening: latest.current.listening, playback: currentPlayback() });
    latest.current.disconnect();
    await wait(300);
    check(
      "production-disconnect-inactive",
      "Production teardown closed capture and ended its generated tracks before QA cleanup",
      () => {
        const resources = currentCaptureResources();
        assertDisconnected({
          captureActive: resources.productionContexts > 0 || resources.liveSyntheticTracks > 0,
          listening: latest.current.listening,
          connection: latest.current.connectionState,
          playback: currentPlayback()
        });
      }
    );
    await releaseSyntheticContext();
    await wait(300);
    observe("case.after.disconnect", {
      listening: latest.current.listening,
      connection: latest.current.connectionState,
      playback: currentPlayback(),
      capture: currentCaptureResources()
    });
    check("disconnect-inactive", "Disconnect released capture, socket and all agent speech", () =>
      assertDisconnected({
        captureActive: currentCaptureResources().captureActive,
        listening: latest.current.listening,
        connection: latest.current.connectionState,
        playback: currentPlayback()
      })
    );
    await save(`${id}-${Date.now()}`, "pass");
    setProgress(`Saved ${id}`);
  }
  async function run(ids: string[]) {
    cancelled.current = false;
    setBusy(true);
    try {
      setProgress("Preflight: verifying all generated fixtures before any relay session opens");
      assertions.current = [];
      await preflightFixtures();
      for (const id of ids) {
        if (cancelled.current) throw new Error("Synthetic run stopped by operator");
        await runCase(id);
      }
      setProgress(
        "Run completed. Inspect saved evidence; synthetic evidence does not establish physical device or road coverage."
      );
    } catch (error) {
      observe("case.error", { message: String(error) });
      setProgress(String(error));
      latest.current.disconnect();
      await releaseSyntheticContext();
      await wait(300);
      try {
        await save(`${latest.current.testingTestCaseId}-error-${Date.now()}`, "fail", String(error));
      } catch (saveError) {
        setProgress(`${String(error)}; failure evidence could not be saved: ${String(saveError)}`);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <h1>Max synthetic browser QA</h1>
      <p className="notice">Synthetic generated speech only · no microphone capture · no location access</p>
      <p>
        Production useHelmetAgent → useMicCapture / AudioWorklet → real Doubao relay → useAudioPlayback. Build{" "}
        {import.meta.env.VITE_GIT_COMMIT}
      </p>
      <div className="controls">
        <select
          aria-label="Test case"
          disabled={busy}
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          {TESTING_TEST_CASES.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <button disabled={busy} onClick={() => void run([selected])}>
          Run selected synthetic case
        </button>
        <button disabled={busy} onClick={() => void run(TESTING_TEST_CASES.map((item) => item.id))}>
          Run all six synthetic cases
        </button>
        <button
          onClick={() => {
            cancelled.current = true;
            agent.disconnect();
            void releaseSyntheticContext();
            observe("manual.disconnect");
          }}
        >
          Stop and disconnect
        </button>
      </div>
      <p role="status">{progress}</p>
      <section className="metrics">
        <b>Provider: {agent.provider}</b>
        <b>Connection: {agent.connectionState}</b>
        <b>Hands-free: {String(agent.listening)}</b>
        <b>Turn: {agent.turnState}</b>
        <b>Audio frames/s: {agent.packetStats.outgoingFps}</b>
        <b>Dropped: {agent.packetStats.droppedFrames}</b>
      </section>
      <p>{agent.status}</p>
      <pre aria-label="Playback lifecycle">{JSON.stringify(currentPlayback(), null, 2)}</pre>
      {agent.hazardAlert && (
        <p className="hazard">
          Hazard: {agent.hazardAlert.message} {agent.hazardAlert.advice}
        </p>
      )}
      <h2>Live transcript</h2>
      <div aria-label="Transcript">
        {agent.transcript.map((item) => (
          <p key={item.id}>
            <b>{item.speaker}</b>: {item.text} {item.final ? "" : "(partial)"}
          </p>
        ))}
      </div>
      <h2>
        Observed events ({observations.length}) · Saved results ({results.length})
      </h2>
      <div aria-label="Saved case results">
        {results.map((result) => (
          <p key={result.id}>
            <b>{result.result.toUpperCase()}</b> {result.id} {result.error ?? ""}
          </p>
        ))}
      </div>
      <pre className="events" aria-label="Event log">
        {observations
          .slice(-22)
          .map((item) => JSON.stringify(item))
          .join("\n")}
      </pre>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
