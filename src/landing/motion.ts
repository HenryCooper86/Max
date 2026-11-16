import { useEffect, useState, type RefObject } from "react";
import type { MascotMood } from "../components/Mascot";

/**
 * Motion for the public pages: things arrive as they are scrolled to, and the
 * page knows which part of it is on screen.
 *
 * All of it is decoration. With reduced motion, or in a browser without
 * IntersectionObserver, everything is simply shown.
 */

function canObserve(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    "IntersectionObserver" in window &&
    !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Reveals every `[data-reveal]` element under the document as it scrolls into
 * view, once. Elements are only hidden while `data-reveal-ready` is set on
 * <html>, so a page whose script never runs still shows all of its content.
 */
export function useScrollReveal(): void {
  useEffect(() => {
    if (!canObserve()) return;
    const root = document.documentElement;
    const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          // On screen, or already scrolled past: a jump down the page by a
          // menu link must not leave what it skipped hidden above.
          if (!entry.isIntersecting && entry.boundingClientRect.bottom > 0) continue;
          (entry.target as HTMLElement).dataset.reveal = "in";
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 }
    );
    for (const target of targets) observer.observe(target);
    root.dataset.revealReady = "";
    return () => {
      observer.disconnect();
      delete root.dataset.revealReady;
      for (const target of targets) target.dataset.reveal = "";
    };
  }, []);
}

/** Whether an element is on screen. Until the first measurement it reports
 *  `initial`: true for something that must not vanish in the meantime, false
 *  for something that should wait to be reached. */
export function useOnScreen(target: RefObject<Element | null>, margin = "0px", initial = true): boolean {
  const [onScreen, setOnScreen] = useState(initial);
  useEffect(() => {
    const element = target.current;
    if (!element || typeof window === "undefined" || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(([entry]) => setOnScreen(Boolean(entry?.isIntersecting)), {
      rootMargin: margin
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [target, margin]);
  return onScreen;
}

/** What the bird does beside each part of the page. */
const SECTION_MOODS: Record<string, MascotMood> = {
  demo: "listening",
  devices: "ready",
  backends: "speaking",
  look: "happy",
  how: "thinking",
  start: "happy"
};

/** The bird's mood for the section that is across the middle of the screen. */
export function useSectionMood(): MascotMood {
  const [mood, setMood] = useState<MascotMood>("ready");
  useEffect(() => {
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute("aria-labelledby") ?? "";
          const next = entry.isIntersecting ? SECTION_MOODS[id] : undefined;
          if (next) setMood(next);
        }
      },
      // A line across the middle of the screen: one section crosses it at a time.
      { rootMargin: "-50% 0px -50% 0px" }
    );
    for (const section of document.querySelectorAll("section[aria-labelledby]")) observer.observe(section);
    return () => observer.disconnect();
  }, []);
  return mood;
}

/**
 * Types `text` out once `active` turns true, a few characters a frame, and
 * says how much of it is showing. Shows it all at once with reduced motion.
 */
export function useTyped(text: string, active: boolean): number {
  const [shown, setShown] = useState(() => (canObserve() ? 0 : text.length));
  useEffect(() => {
    if (!active || shown >= text.length) return;
    const timer = setTimeout(() => setShown((count) => Math.min(text.length, count + 2)), 22);
    return () => clearTimeout(timer);
  }, [active, shown, text.length]);
  return Math.min(shown, text.length);
}
