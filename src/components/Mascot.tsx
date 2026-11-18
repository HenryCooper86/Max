import { useEffect, useRef, useState } from "react";

/**
 * The assistant's character: a real hummingbird, filmed hovering, cut out of
 * its background so it flies over the page.
 *
 * A filmed bird cannot act, so the moods are shown by how it flies: it leans
 * in to listen, drifts while it thinks, bobs as the assistant speaks and
 * starts back when something is wrong. The footage is a transparent video
 * and, for phones and Safari, an animated picture; with reduced motion, or
 * where the video will not play, a still frame is shown instead.
 *
 * Footage credit: public/character/CREDITS.txt.
 */

export type MascotMood = "ready" | "listening" | "thinking" | "speaking" | "happy" | "alert" | "asleep" | "wink";

/** The mood that goes with the assistant's live state, for surfaces that
 *  already drive the lens from it. */
export function mascotMoodFor(state: {
  connected: boolean;
  turnState: "idle" | "listening" | "hearing" | "thinking" | "speaking";
  hazardLevel?: "normal" | "caution" | "critical";
  sessionState?: "inactive" | "starting";
}): MascotMood {
  if (!state.connected) {
    if (state.sessionState === "starting") return "thinking";
    return state.sessionState === "inactive" ? "ready" : "asleep";
  }
  if (state.hazardLevel && state.hazardLevel !== "normal") return "alert";
  if (state.turnState === "thinking") return "thinking";
  if (state.turnState === "speaking") return "speaking";
  if (state.turnState === "listening" || state.turnState === "hearing") return "listening";
  return "ready";
}

const BASE = "/character/hummingbird";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/** How fast the footage plays for a mood. The clip is real time, and the
 *  range is narrow on purpose: slowed much further, the wings stop looking
 *  like a hummingbird's. */
const SPEED: Record<MascotMood, number> = {
  ready: 1,
  listening: 0.9,
  thinking: 0.85,
  speaking: 1.1,
  happy: 1.25,
  alert: 1.3,
  asleep: 0.85,
  wink: 1
};

/** Where the beak tip sits in the footage, from the centre, as a fraction of
 *  the frame, with the bird facing right. */
const BEAK = { x: 0.2, y: -0.12 };
/** How far the bird keeps its beak from the cursor, in pixels. */
const REACH = 26;
/** After this long without the cursor moving, the bird flies home. */
const HOME_AFTER_MS = 2600;

/** Whether this is a phone or tablet: a finger, not a mouse. */
function isTouchDevice(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(pointer: coarse)").matches);
}

/**
 * Whether the bird is shown as an animated picture instead of the video.
 * Phones and Safari are: several of them play a transparent video with its
 * background showing, as a box round the bird. A picture's transparency holds
 * everywhere.
 */
function usesPicture(): boolean {
  if (typeof navigator === "undefined") return false;
  const safari = /safari/i.test(navigator.userAgent) && !/chrome|chromium|android|edg/i.test(navigator.userAgent);
  return isTouchDevice() || safari;
}

/** How far a full tilt of the phone carries the bird from home, in pixels. */
const TILT_REACH = { x: 80, y: 56 };
/** The tilt, in degrees either way, that carries it that far. */
const TILT_FULL = 24;

type MotionPermission = { requestPermission?: () => Promise<"granted" | "denied"> };

/**
 * Flies the bird to the cursor or the finger. It trails the pointer on a
 * spring, turns to face the way it is going, tips with its climb, and stops
 * with its beak just short of the pointer, as it would at a flower. It goes
 * home when the pointer rests, leaves the window, or moves over `restOver` (a
 * form it should not cover).
 *
 * On a phone, home itself moves: the bird leans the way the phone is tilted,
 * measured from how the phone was first held. iOS only reports tilt after the
 * visitor allows it, and is asked when they first touch the bird. Reduced
 * motion turns all of this off.
 */
function useCursorFlight(enabled: boolean, restOver: string | undefined) {
  const node = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = node.current;
    if (!enabled || !element || typeof window === "undefined" || !window.requestAnimationFrame) return;

    const position = { x: 0, y: 0 };
    const velocity = { x: 0, y: 0 };
    const target = { x: 0, y: 0 };
    /** Where the tilt of the phone puts home; the origin without tilt. */
    const lean = { x: 0, y: 0 };
    let chasing = false;
    let facing = 1;
    let frame = 0;
    let last = 0;
    let homeTimer: ReturnType<typeof setTimeout> | undefined;

    const goHome = () => {
      chasing = false;
      target.x = lean.x;
      target.y = lean.y;
      start();
    };

    const tick = (now: number) => {
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
      last = now;
      // A soft spring: quick to set off, a little overshoot on arrival.
      velocity.x += ((target.x - position.x) * 46 - velocity.x * 9.5) * dt;
      velocity.y += ((target.y - position.y) * 46 - velocity.y * 9.5) * dt;
      position.x += velocity.x * dt;
      position.y += velocity.y * dt;
      if (Math.abs(velocity.x) > 40) facing = velocity.x > 0 ? 1 : -1;
      const settled =
        Math.abs(velocity.x) + Math.abs(velocity.y) < 2 &&
        Math.abs(target.x - position.x) + Math.abs(target.y - position.y) < 0.6;
      // Home is drawn facing right.
      if (settled && !chasing) facing = 1;
      const tilt = Math.max(-18, Math.min(18, velocity.y * 0.035)) * facing;
      element.style.transform = `translate(${position.x.toFixed(1)}px, ${position.y.toFixed(1)}px) rotate(${tilt.toFixed(1)}deg) scaleX(${facing})`;
      if (settled) {
        frame = 0;
        last = 0;
        return;
      }
      frame = window.requestAnimationFrame(tick);
    };
    function start() {
      if (!frame) frame = window.requestAnimationFrame(tick);
    }

    /** The middle of the bird's resting place, on screen. */
    const home = (box: DOMRect) => ({
      x: box.left + box.width / 2 - position.x,
      y: box.top + box.height / 2 - position.y
    });

    const onMove = (event: PointerEvent) => {
      clearTimeout(homeTimer);
      const over = event.target instanceof Element && restOver ? event.target.closest(restOver) : null;
      if (over) {
        goHome();
        return;
      }
      const box = element.getBoundingClientRect();
      const { x: homeX, y: homeY } = home(box);
      const side = event.clientX >= homeX + position.x ? 1 : -1;
      chasing = true;
      target.x = event.clientX - homeX - side * (BEAK.x * box.width + REACH);
      target.y = event.clientY - homeY - BEAK.y * box.height;
      homeTimer = setTimeout(goHome, HOME_AFTER_MS);
      start();
    };
    const onLeave = () => {
      clearTimeout(homeTimer);
      goHome();
    };

    // Tilt, where the device reports it.
    let level: { x: number; y: number } | undefined;
    const onTilt = (event: DeviceOrientationEvent) => {
      if (event.beta === null || event.gamma === null) return;
      const turned = Math.abs(window.screen?.orientation?.angle ?? 0) % 180 === 90;
      const now = turned ? { x: event.beta, y: -event.gamma } : { x: event.gamma, y: event.beta };
      level ??= now;
      const part = (value: number) => Math.max(-1, Math.min(1, value / TILT_FULL));
      lean.x = part(now.x - level.x) * TILT_REACH.x;
      lean.y = part(now.y - level.y) * TILT_REACH.y;
      if (chasing) return;
      if (Math.abs(lean.x - target.x) + Math.abs(lean.y - target.y) < 1) return;
      target.x = lean.x;
      target.y = lean.y;
      start();
    };
    const motion =
      typeof DeviceOrientationEvent === "undefined" ? undefined : (DeviceOrientationEvent as MotionPermission);
    let listening = false;
    const listenForTilt = () => {
      if (listening || !motion) return;
      listening = true;
      window.addEventListener("deviceorientation", onTilt);
    };
    // iOS asks the visitor; it may only be asked from a touch, and it is only
    // asked when that touch is on the bird.
    const onDown = (event: PointerEvent) => {
      onMove(event);
      if (listening || !motion?.requestPermission) return;
      const box = element.getBoundingClientRect();
      const onBird =
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom;
      if (!onBird) return;
      motion
        .requestPermission()
        .then((answer) => {
          if (answer === "granted") listenForTilt();
        })
        .catch(() => undefined);
    };
    if (motion && !motion.requestPermission && isTouchDevice()) listenForTilt();

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("deviceorientation", onTilt);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      clearTimeout(homeTimer);
      if (frame) window.cancelAnimationFrame(frame);
      element.style.transform = "";
    };
  }, [enabled, restOver]);

  return node;
}

type Props = {
  mood?: MascotMood;
  className?: string;
  /** Read out by screen readers when set; the figure is decorative otherwise. */
  label?: string;
  /** Fly to the cursor and follow it round the page. */
  followCursor?: boolean;
  /** A selector the bird keeps clear of: over it, the bird flies home. */
  restOver?: string;
};

export function Mascot({ mood = "ready", className = "", label, followCursor = false, restOver }: Props) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [still, setStill] = useState(prefersReducedMotion);
  const [picture] = useState(usesPicture);
  // A phone may refuse to autoplay (Low Power Mode, a data saver) and would
  // then show a frozen frame under a play button. Ask once more, and if the
  // answer is still no, show the still picture instead.
  const playOrFallBack = () => {
    const film = video.current;
    if (!film || !film.paused) return;
    film.play().catch(() => setStill(true));
  };
  const flight = useCursorFlight(followCursor && !still, restOver);

  useEffect(() => {
    if (video.current) video.current.playbackRate = SPEED[mood];
  }, [mood]);

  return (
    <div
      className={`mascot ${mood} ${className}`.trim()}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <div className="mascotFollow" ref={flight}>
        <div className="mascotFlight">
          {still ? (
            <img className="mascotFilm" src={`${BASE}.png`} alt="" draggable={false} />
          ) : picture ? (
            <img className="mascotFilm" src={`${BASE}.webp`} alt="" draggable={false} decoding="async" />
          ) : (
            <video
              ref={video}
              className="mascotFilm"
              poster={`${BASE}.png`}
              autoPlay
              loop
              muted
              playsInline
              disablePictureInPicture
              preload="auto"
              onCanPlay={playOrFallBack}
            >
              <source src={`${BASE}.webm`} type="video/webm" />
            </video>
          )}
        </div>
      </div>
    </div>
  );
}
