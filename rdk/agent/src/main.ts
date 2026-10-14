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
import { createDeviceDispatcher, type DeviceCommand } from "./device/dispatch";
import { loadOrCreateDeviceId } from "./device/identity";
import { createPoweroffController } from "./device/poweroff";
import { writeCue } from "./audio/cues";
import { createDiscoveryAdvertiser } from "./discovery/advertiser";
import { createMdnsTransport } from "./discovery/mdns";
import { createHudServer } from "./hud/server";
import { initialHudState, reduceHud, type HudCompanion, type HudEvent } from "./hud/state";
import { createHazardHandler } from "./hazard";
import { createRdkNavigationController, type RdkNavigationController } from "./navigation/controller";
import {
  createPhoneLocationSource,
  type PhoneLocationSource,
  type PhoneLocationState
} from "./navigation/phone-location";
import { createRelayClient, nextBackoffMs } from "./relay";
import { createVisionClient, type VisionClient, type VisionEvent } from "./vision-client";
import { startHeartbeat } from "./watchdog";
import type { AgentEvent, DeviceResultEvent } from "../../../shared/agent";
import { NAV_FABRICATION_CLEAR_DETAIL } from "../../../shared/nav-fabrication";

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

export async function routeDeviceCommand(options: {
  command: DeviceCommand;
  navigation: RdkNavigationController;
  dispatch: ReturnType<typeof createDeviceDispatcher>;
}): Promise<DeviceResultEvent> {
  try {
    if (options.command.action === "navigation.start" || options.command.action === "navigation.stop") {
      return await options.navigation.handleCommand(options.command);
    }
    return await options.dispatch(options.command);
  } catch {
    return {
      type: "device.result",
      commandId: options.command.commandId,
      status: "failed"
    };
  }
}

export function routeAgentNavigationEvent(
  event: AgentEvent,
  location: PhoneLocationSource,
  navigation: RdkNavigationController
): boolean {
  try {
    if (event.type === "nav.route") {
      navigation.handleRoute(event);
      return true;
    }
    if (event.type === "nav.error") {
      navigation.handleError(event);
      return true;
    }
    if (event.type === "phone.location") {
      location.acceptLocation(event);
      return true;
    }
    if (event.type === "phone.location.status") {
      location.acceptStatus(event);
      return true;
    }
    return false;
  } catch {
    // A stale or synchronously closing session owns this event even when its
    // callback refuses it. Do not fall through and route it a second time.
    return true;
  }
}

type PoweroffChild = {
  on(event: "error", listener: (error: Error) => void): void;
  unref(): void;
};

export type PoweroffSpawn = (command: string, args: string[]) => PoweroffChild;

/**
 * Runs the actual poweroff behind "Max，关机".
 *
 * Extracted and injectable because of the failure it now handles: a missing or
 * non-executable `shutdown` does not throw from spawn(), it arrives later as an
 * 'error' event on the child. With no listener that is an unhandled 'error',
 * which reaches the uncaughtException hook below and exits the agent — after
 * the rider has already heard the final tone and is expecting the board to go
 * down. Systemd restarts us and the helmet stays on, with nothing in the
 * journal naming the cause. Log it instead: the board being up is then a
 * visible fact rather than a mystery.
 */
export function runPoweroffCommand(options: { spawn?: PoweroffSpawn; log?: (line: string) => void } = {}): void {
  const log = options.log ?? ((line: string) => console.log(line));
  const spawnChild =
    options.spawn ??
    ((command: string, args: string[]) => spawn(command, args, { stdio: "ignore" }) as unknown as PoweroffChild);
  // Clean by construction: systemd stops both services, max-vision finalizes a
  // live recording, filesystems unmount. This exists because every hard power
  // cut this week cost something on the next boot.
  log("[device] voice shutdown: running shutdown -h now");
  const child = spawnChild("/usr/sbin/shutdown", ["-h", "now"]);
  child.on("error", (error) => {
    log(`[device] shutdown failed to start: ${error.message}; the board is still up`);
  });
  child.unref();
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

export type VisionEventRouterOptions = {
  hazards: { handle(event: VisionEvent): Promise<void> };
  /** Same client-event path hazard.report already uses (relay.sendEvent) —
   *  not a new one. */
  sendEvent(event: unknown): void;
  log?: (line: string) => void;
};

/**
 * Routes an unsolicited vision-sidecar event. Extracted out of the
 * `connectVision` callback in `start()` so it is directly testable: a hazard
 * goes to the ADAS handler as before; a `watch.frame` push (from the
 * sidecar's WatchSampler) becomes a single-image `vision.frames` event to the
 * relay; anything else is only logged, unchanged from before this event
 * carried real payloads.
 */
export function createVisionEventRouter(options: VisionEventRouterOptions): (event: VisionEvent) => void {
  const log = options.log ?? ((line: string) => console.log(line));
  return (event: VisionEvent): void => {
    if (event.event === "hazard") {
      void options.hazards.handle(event);
      return;
    }
    if (event.event === "watch.frame") {
      const image = event.image;
      // The sidecar's payload is unknown-typed on this wire; a malformed push
      // must be dropped, not forwarded — the relay rejects an invalid
      // vision.frames event, and that failure would otherwise be silent on
      // the board. Same skip-don't-throw posture as vision-client.ts's line
      // decoder.
      if (typeof image !== "string" || image.length === 0) {
        log(`[vision] dropped watch.frame with invalid image`);
        return;
      }
      options.sendEvent({ type: "vision.frames", reason: "watch", index: 0, total: 1, image });
      return;
    }
    log(`[vision] ${JSON.stringify(event)}`);
  };
}

/**
 * Best-effort: turns proactive watching off when the relay session ends.
 * Watching dies with the session — a reconnecting rider must explicitly
 * re-enable it, not resume from a stale toggle left on from before the drop.
 * The vision socket may be down too (that is a separate failure the sidecar
 * reconnect loop already handles), so a rejection here is swallowed rather
 * than surfaced.
 */
export function stopWatchOnClose(vision: Pick<VisionClient, "request">): void {
  void vision.request("vision.watch", { on: false }).catch(() => {});
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
  // Load once at startup, before networking: a persistence failure must stop
  // this process so systemd reports it rather than rotating a trusted pairing.
  const deviceId = loadOrCreateDeviceId({ path: config.deviceIdFile });
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

  const hud = createHudServer(config.hudPort, config.visionPreviewPort, config.visionToken);
  if (!config.visionToken) {
    console.log("[hud] MAX_VISION_TOKEN is unset; the HUD serves 127.0.0.1 only and refuses every other peer");
  }
  let hudState = initialHudState();

  function publishHud(event: HudEvent): void {
    hudState = reduceHud(hudState, event);
    hud.publish(hudState);
  }

  const advertiser = createDiscoveryAdvertiser({
    transports: [createMdnsTransport({ port: config.hudPort })],
    onStatus: (status) => publishHud({ type: "rdk.discovery", discovery: status })
  });

  function companionForLocation(state: PhoneLocationState): HudCompanion {
    const current = hudState.companion;
    return {
      paired: current.paired,
      locationState: state.connection,
      ...(current.pairingCode === undefined ? {} : { pairingCode: current.pairingCode }),
      ...(current.pairingExpiresAt === undefined ? {} : { pairingExpiresAt: current.pairingExpiresAt }),
      ...(state.horizontalAccuracyMeters === undefined
        ? {}
        : { horizontalAccuracyMeters: state.horizontalAccuracyMeters }),
      ...(state.ageMs === undefined ? {} : { lastFixAgeMs: state.ageMs })
    };
  }

  type NavigationSession = {
    location: PhoneLocationSource;
    navigation: RdkNavigationController;
    closed: boolean;
  };

  let activeNavigationGeneration = 0;

  function createNavigationSession(): NavigationSession {
    const generation = ++activeNavigationGeneration;
    const ownsCallbacks = (): boolean => generation === activeNavigationGeneration;
    const location = createPhoneLocationSource({
      onFix: (fix) => {
        if (!ownsCallbacks()) return;
        navigation.handleFix(fix);
      },
      onState: (state) => {
        if (!ownsCallbacks()) return;
        navigation.handleLocationState(state);
        if (!ownsCallbacks()) return;
        publishHud({ type: "rdk.companion", companion: companionForLocation(state) });
      }
    });
    const navigation = createRdkNavigationController({
      location,
      sendEvent: (event) => relay.sendEvent(event),
      onState: (state) => {
        if (!ownsCallbacks()) return;
        publishHud({ type: "rdk.navigation", navigation: state.phase === "idle" ? null : state });
      },
      onRoute: (route) => {
        if (!ownsCallbacks()) return;
        publishHud({ type: "rdk.route", route });
      },
      canPrompt: () => playback.priorityRank() === 0,
      interruptOrdinaryPlayback: () => playback.flush()
    });
    return { location, navigation, closed: false };
  }

  let navigationSession = createNavigationSession();

  function closeNavigationSession(): void {
    if (navigationSession.closed) return;
    navigationSession.closed = true;
    activeNavigationGeneration += 1;
    navigationSession.navigation.close();
    navigationSession.location.close();
    // Route first, matching the controller's own teardown wire order:
    // `clearRouteState` emits `route: null` as its last statement, and every
    // caller publishes the idle snapshot afterwards — so on the wire the route
    // clears before the snapshot goes idle. The other order publishes an
    // intermediate frame holding a live route with no rider dot, so the card
    // blinks a dotless polyline before it goes. Nothing tests this ordering;
    // this comment is its only guard.
    publishHud({ type: "rdk.route", route: null });
    publishHud({ type: "rdk.navigation", navigation: null });
  }

  function ensureNavigationSession(): void {
    if (navigationSession.closed) navigationSession = createNavigationSession();
  }

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

  const vision = connectVision(
    config.visionSocket,
    createVisionEventRouter({ hazards, sendEvent: (event) => relay.sendEvent(event) })
  );

  const poweroff = createPoweroffController({
    exec: () => runPoweroffCommand(),
    cue: (kind) => writeCue(playback, kind)
  });

  const dispatcherOptions = {
    vision,
    setVolume: (level: number) => setAlsaVolume(config.alsaPlayback, level),
    previewPort: config.visionPreviewPort,
    poweroff
    // Same client-event path hazard.report already uses below (relay.sendEvent),
    // not a new one: image bytes go up base64-encoded in a camera.frame JSON
    // event, never over the raw binary uplink that carries mic audio.
  };

  const relay = createRelayClient(config, deviceId, {
    onReady: () => {
      if (!shuttingDown) ensureNavigationSession();
      attempt = 0;
      waitingForVoice = false;
      console.log("[relay] session ready");
    },
    onVoice: (pcm) => playback.write(pcm),
    onEvent: (event) => {
      publishHud(event);
      routeAgentNavigationEvent(event, navigationSession.location, navigationSession.navigation);
      if (event.type === "companion.discovery") {
        advertiser.setToken(event.token);
      }
      if (event.type === "status" && event.state === "hearing") {
        if (event.detail === NAV_FABRICATION_CLEAR_DETAIL) {
          // The relay caught the model fabricating navigation — not rider
          // speech, so there is no mic signal to corroborate and never will
          // be. Flush unconditionally: whatever fabricated audio is already
          // queued or playing must stop now, the same way a confirmed
          // barge-in below does.
          playback.flush();
        } else {
          // Barge-in: the rider started talking, so drop the queued reply —
          // but only if our own echo-cancelled mic heard them too. Doubao's
          // VAD runs on the uplink, so residual echo trips it while Max is
          // speaking, and acting on that is what made the loop
          // self-sustaining.
          bargeIn.request(() => {
            console.log("[audio] barge-in confirmed by the mic; cutting the reply");
            playback.flush();
          });
        }
      }
      if (event.type === "hazard.alert" && event.interrupt) {
        playback.flush();
      }
      if (event.type === "device.command") {
        const command = { commandId: event.commandId, action: event.action, args: event.args };
        const reply = relay.captureEventSender();
        const dispatch = createDeviceDispatcher({
          ...dispatcherOptions,
          onFrame: (commandId, jpeg) => reply({ type: "camera.frame", commandId, image: jpeg.toString("base64") })
        });
        void routeDeviceCommand({ command, navigation: navigationSession.navigation, dispatch }).then((result) =>
          reply(result)
        );
      }
    },
    onClosed: (idle) => {
      closeNavigationSession();
      advertiser.setToken(null);
      playback.flush();
      // Watching dies with the session: a reconnecting rider must explicitly
      // re-enable it rather than resume from a stale toggle left on from
      // before the drop.
      stopWatchOnClose(vision);
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
    void advertiser.close();
    closeNavigationSession();
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
