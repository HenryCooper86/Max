import { spawn } from "node:child_process";
import { Socket } from "node:net";
import { createAlertPlayer } from "./audio/alert-player";
import { createCapture } from "./audio/capture";
import { createBargeInGuard } from "./audio/barge-in";
import { rms } from "./audio/dsp";
import { applyCrosstalk } from "./audio/mixer";
import { createPlayback } from "./audio/playback";
import { createReferenceSink, type ReferenceSink } from "./audio/reference";
import { createVoiceGate } from "./audio/voice-gate";
import { loadConfig } from "./config";
import { createDeviceDispatcher } from "./device/dispatch";
import { createPoweroffController } from "./device/poweroff";
import { writeCue } from "./audio/cues";
import { createHudServer } from "./hud/server";
import { initialHudState, reduceHud } from "./hud/state";
import { createHazardHandler } from "./hazard";
import { createRelayClient, nextBackoffMs } from "./relay";
import { createVisionClient, type VisionClient, type VisionEvent } from "./vision-client";
import { startHeartbeat } from "./watchdog";

const VISION_RECONNECT_MS = 2_000;

export type CloseReason = "idle" | "dropped" | "intentional";

/**
 * Reconnect policy. The idle case is the embedded-only one: the relay frees the
 * upstream slot on purpose, and blindly reconnecting would immediately re-open
 * what the idle timeout just closed. With no button on the helmet, the local
 * voice gate is what brings the session back.
 */
export function decideReconnect(reason: CloseReason, gateOpen: boolean): "now" | "wait-for-voice" | "never" {
  if (reason === "intentional") return "never";
  if (reason === "dropped") return "now";
  return gateOpen ? "now" : "wait-for-voice";
}

/** The onClosed wiring, extracted so a test can prove the gate state is real —
 *  it was hardcoded `false` for a while, which made the "now" branch dead. */
export function reconnectDecision(
  shuttingDown: boolean,
  idle: boolean,
  gateOpen: boolean
): "now" | "wait-for-voice" | "never" {
  const reason: CloseReason = shuttingDown ? "intentional" : idle ? "idle" : "dropped";
  return decideReconnect(reason, gateOpen);
}

/**
 * Applies playback volume on the ES8326B mixer. Resolves false if amixer did not
 * exit cleanly, so Max never claims a volume change that did not happen.
 */
function setAlsaVolume(device: string, level: number): Promise<boolean> {
  return new Promise((resolve) => {
    const percent = Math.round(Math.min(1, Math.max(0, level)) * 100);
    const card = device.includes(":") ? (device.split(":")[1]?.split(",")[0] ?? "0") : "0";
    const child = spawn("amixer", ["-c", card, "sset", "Playback", `${percent}%`]);
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/**
 * Connects to the vision sidecar's control socket. A dead sidecar must never
 * leave the relay waiting: every in-flight request is failed immediately so each
 * device.command still gets exactly one device.result.
 */
function connectVision(socketPath: string, onEvent: (event: VisionEvent) => void): VisionClient {
  const socket = new Socket();
  const client = createVisionClient({
    send: (line) => socket.write(line),
    onEvent
  });
  socket.on("data", (chunk: Buffer) => client.handleChunk(chunk.toString("utf8")));
  socket.on("error", () => client.failAllPending("capture.failed"));
  socket.on("close", () => {
    client.failAllPending("capture.failed");
    setTimeout(() => socket.connect(socketPath), VISION_RECONNECT_MS);
  });
  socket.connect(socketPath);
  return client;
}

function start(): void {
  const config = loadConfig();
  let attempt = 0;
  let waitingForVoice = false;
  let gateOpen = false;
  let shuttingDown = false;
  let lastFrameAt = Date.now();

  const gate = createVoiceGate({ rmsThreshold: config.voiceGateRms, sustainMs: config.voiceGateMs });

  const aecActive = config.aecMode === "apm";
  // With real cancellation the hardware duck comes off, which is what lets the
  // rider be heard while Max is talking. With AEC off it goes back on, because
  // an echo loop is worse than no barge-in.
  void applyCrosstalk(aecActive).then((ok) => {
    if (!ok) console.log("[audio] could not set CROSSTALK; check amixer");
  });

  // With AEC off the local gate hears Max at full volume, so it cannot witness
  // a barge-in and the relay is trusted as before.
  const bargeIn = createBargeInGuard({
    rmsThreshold: config.voiceGateRms,
    windowMs: 600,
    enabled: aecActive
  });

  // Reassigned once capture spawns max-aec and hands over fd 3. Until then it
  // is a no-op sink, so playback works whether or not AEC is running.
  let referenceSink: ReferenceSink = createReferenceSink({ stream: null });
  const playback = createPlayback({
    device: config.alsaPlayback,
    reference: {
      write: (pcm) => referenceSink.write(pcm),
      flush: () => referenceSink.flush(),
      close: () => referenceSink.close()
    }
  });

  const hud = createHudServer(config.hudPort, config.visionPreviewPort);
  let hudState = initialHudState();

  // Hazards arrive on the sidecar's event channel. In shadow mode this only
  // logs; MAX_ADAS_AUDIO=1 is what makes it speak, and that requires the M1
  // gate to have been met against recorded evidence.
  const hazards = createHazardHandler({
    armed: config.adasAudio,
    player: createAlertPlayer({ dir: config.adasAudioDir, playback }),
    report: (event) => relay.sendEvent(event as never)
  });
  if (config.adasAudio) {
    console.log("[adas] ALERT AUDIO ARMED — shadow numbers must have met the M1 gate");
  } else {
    console.log("[adas] shadow mode: hazards are logged, never spoken");
  }

  const vision = connectVision(config.visionSocket, (event) => {
    if (event.event === "hazard") {
      void hazards.handle(event as never);
      return;
    }
    console.log("[vision]", JSON.stringify(event));
  });

  const poweroff = createPoweroffController({
    exec: () => {
      // Clean by construction: systemd stops both services, max-vision
      // finalizes a live recording, filesystems unmount. This exists because
      // every hard power cut this week cost something on the next boot.
      console.log("[device] voice shutdown: running shutdown -h now");
      spawn("/usr/sbin/shutdown", ["-h", "now"], { stdio: "ignore" }).unref();
    },
    cue: (kind) => writeCue(playback, kind)
  });

  const dispatch = createDeviceDispatcher({
    vision,
    setVolume: (level) => setAlsaVolume(config.alsaPlayback, level),
    previewPort: config.visionPreviewPort,
    poweroff,
    // Same client-event path hazard.report already uses below (relay.sendEvent),
    // not a new one: image bytes go up base64-encoded in a camera.frame JSON
    // event, never over the raw binary uplink that carries mic audio.
    onFrame: (commandId, jpeg) => relay.sendEvent({ type: "camera.frame", commandId, image: jpeg.toString("base64") })
  });

  const relay = createRelayClient(config, {
    onReady: () => {
      attempt = 0;
      waitingForVoice = false;
      console.log("[relay] session ready");
    },
    onVoice: (pcm) => playback.write(pcm),
    onEvent: (event) => {
      hudState = reduceHud(hudState, event);
      hud.publish(hudState);
      if (event.type === "status" && event.state === "hearing") {
        // Barge-in: the rider started talking, so drop the queued reply — but
        // only if our own echo-cancelled mic heard them too. Doubao's VAD runs
        // on the uplink, so residual echo trips it while Max is speaking, and
        // acting on that is what made the loop self-sustaining.
        bargeIn.request(() => {
          console.log("[audio] barge-in confirmed by the mic; cutting the reply");
          playback.flush();
        });
      }
      if (event.type === "hazard.alert" && event.interrupt) {
        playback.flush();
      }
      if (event.type === "device.command") {
        void dispatch({ commandId: event.commandId, action: event.action, args: event.args }).then((result) =>
          relay.sendEvent(result)
        );
      }
    },
    onClosed: (idle) => {
      playback.flush();
      const decision = reconnectDecision(shuttingDown, idle, gateOpen);
      if (decision === "never") return;
      if (decision === "wait-for-voice") {
        waitingForVoice = true;
        console.log("[relay] idle close; waiting for the rider to speak");
        return;
      }
      const delay = nextBackoffMs(attempt);
      attempt += 1;
      console.log(`[relay] reconnecting in ${delay} ms`);
      setTimeout(() => relay.connect(), delay);
    }
  });

  const capture = createCapture({
    device: config.alsaCapture,
    aec: aecActive
      ? {
          bin: config.aecBin,
          delayMs: config.aecDelayMs,
          suppression: config.aecSuppression,
          dump: config.aecDump
        }
      : undefined,
    onReference: (stream) => {
      referenceSink = createReferenceSink({ stream });
    },
    onFatal: (reason) => {
      console.log(`[capture] ${reason}; exiting for systemd to restart`);
      process.exit(1);
    },
    onFrame: (frame) => {
      lastFrameAt = Date.now();
      const speaking = gate(frame);
      gateOpen = speaking;
      // Raw level, not the gate's verdict: the gate waits 400 ms for sustained
      // speech, which is far slower than the relay's barge-in event.
      bargeIn.observe(rms(frame));
      if (waitingForVoice && speaking) {
        waitingForVoice = false;
        console.log("[relay] rider spoke; reopening the session");
        relay.connect();
      }
      relay.sendFrame(frame);
    }
  });

  capture.start();
  relay.connect();

  startHeartbeat({ isHealthy: () => Date.now() - lastFrameAt < 10_000 });

  process.on("uncaughtException", (error) => {
    console.log(`[agent] uncaught exception: ${error.stack ?? error.message}`);
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.log(
      `[agent] unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`
    );
    process.exit(1);
  });

  const shutdown = (): void => {
    shuttingDown = true;
    capture.stop();
    playback.stop();
    relay.disconnect();
    hud.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Only start when executed directly, so the tests can import decideReconnect.
if (process.argv[1]?.endsWith("main.ts")) start();
