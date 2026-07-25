import { spawn } from "node:child_process";
import { createCapture } from "./audio/capture";
import { createPlayback } from "./audio/playback";
import { createVoiceGate } from "./audio/voice-gate";
import { loadConfig } from "./config";
import { createDeviceDispatcher } from "./device/dispatch";
import { createRelayClient, nextBackoffMs } from "./relay";
import { createVisionClient } from "./vision-client";

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

function start(): void {
  const config = loadConfig();
  let attempt = 0;
  let waitingForVoice = false;
  let shuttingDown = false;

  const gate = createVoiceGate({ rmsThreshold: config.voiceGateRms, sustainMs: config.voiceGateMs });
  const playback = createPlayback({ device: config.alsaPlayback });

  const vision = createVisionClient({
    send: () => {
      // Connected to the unix socket in Task 11; until then camera actions fail
      // truthfully rather than pretending to succeed.
    },
    onEvent: (event) => console.log("[vision]", JSON.stringify(event))
  });

  const dispatch = createDeviceDispatcher({
    vision,
    setVolume: (level) => setAlsaVolume(config.alsaPlayback, level)
  });

  const relay = createRelayClient(config, {
    onReady: () => {
      attempt = 0;
      waitingForVoice = false;
      console.log("[relay] session ready");
    },
    onVoice: (pcm) => playback.write(pcm),
    onEvent: (event) => {
      if (event.type === "status" && event.state === "hearing") {
        // Barge-in: the rider started talking, so drop the queued reply.
        playback.flush();
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
      const reason: CloseReason = shuttingDown ? "intentional" : idle ? "idle" : "dropped";
      const decision = decideReconnect(reason, false);
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
    onFrame: (frame) => {
      const speaking = gate(frame);
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

  const shutdown = (): void => {
    shuttingDown = true;
    capture.stop();
    playback.stop();
    relay.disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Only start when executed directly, so the tests can import decideReconnect.
if (process.argv[1]?.endsWith("main.ts")) start();
