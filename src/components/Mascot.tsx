import { useEffect, useRef, useState } from "react";

/**
 * The assistant's character: a real hummingbird, filmed hovering, cut out of
 * its background so it flies over the page.
 *
 * A filmed bird cannot act, so the moods are shown by how it flies: it leans
 * in to listen, drifts while it thinks, bobs as the assistant speaks and
 * starts back when something is wrong. The footage is a transparent video in
 * two encodings (HEVC for Safari, VP9 for the rest); with reduced motion, or
 * where neither plays, a still frame is shown instead.
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

/**
 * Flies the bird to the cursor. It trails the pointer on a spring, turns to
 * face the way it is going, tips with its climb, and stops with its beak just
 * short of the cursor, as it would at a flower. It goes home when the cursor
 * rests, leaves the window, or moves over `restOver` (a form it should not
 * cover). Touch has no cursor to follow, and reduced motion turns this off.
 */
function useCursorFlight(enabled: boolean, restOver: string | undefined) {
  const node = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = node.current;
    if (!enabled || !element || typeof window === "undefined" || !window.requestAnimationFrame) return;

    const position = { x: 0, y: 0 };
    const velocity = { x: 0, y: 0 };
    const target = { x: 0, y: 0 };
    let facing = 1;
    let frame = 0;
    let last = 0;
    let homeTimer: ReturnType<typeof setTimeout> | undefined;

    const goHome = () => {
      target.x = 0;
      target.y = 0;
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
      const tilt = Math.max(-18, Math.min(18, velocity.y * 0.035)) * facing;
      element.style.transform = `translate(${position.x.toFixed(1)}px, ${position.y.toFixed(1)}px) rotate(${tilt.toFixed(1)}deg) scaleX(${facing})`;
      const settled =
        Math.abs(velocity.x) + Math.abs(velocity.y) < 2 &&
        Math.abs(target.x - position.x) + Math.abs(target.y - position.y) < 0.6;
      if (settled) {
        // Home is drawn facing right.
        if (target.x === 0 && target.y === 0 && facing !== 1) {
          facing = 1;
          element.style.transform = "";
        }
        frame = 0;
        last = 0;
        return;
      }
      frame = window.requestAnimationFrame(tick);
    };
    function start() {
      if (!frame) frame = window.requestAnimationFrame(tick);
    }

    const onMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      clearTimeout(homeTimer);
      const over = event.target instanceof Element && restOver ? event.target.closest(restOver) : null;
      if (over) {
        goHome();
        return;
      }
      // Home is where the element sits when it has not been moved.
      const box = element.getBoundingClientRect();
      const homeX = box.left + box.width / 2 - position.x;
      const homeY = box.top + box.height / 2 - position.y;
      const side = event.clientX >= homeX + position.x ? 1 : -1;
      target.x = event.clientX - homeX - side * (BEAK.x * box.width + REACH);
      target.y = event.clientY - homeY - BEAK.y * box.height;
      homeTimer = setTimeout(goHome, HOME_AFTER_MS);
      start();
    };
    const onLeave = () => {
      clearTimeout(homeTimer);
      goHome();
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
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
              <source src={`${BASE}.mov`} type='video/mp4; codecs="hvc1"' />
              <source src={`${BASE}.webm`} type="video/webm" />
            </video>
          )}
        </div>
      </div>
    </div>
  );
}
