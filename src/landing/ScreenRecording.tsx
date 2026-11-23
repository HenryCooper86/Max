import { useEffect, useRef, useState } from "react";
import { useOnScreen } from "./motion";

/** A silent screen recording. It plays only while on screen, and not at all with reduced motion. */
export function ScreenRecording({ src, poster, label }: { src: string; poster: string; label: string }) {
  const video = useRef<HTMLVideoElement | null>(null);
  const onScreen = useOnScreen(video, "0px", false);
  const [still] = useState(
    () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
  );
  useEffect(() => {
    const element = video.current;
    if (!element || still) return;
    if (onScreen) void element.play().catch(() => undefined);
    else element.pause();
  }, [onScreen, still, src]);
  return (
    <video
      ref={video}
      src={src}
      poster={poster}
      aria-label={label}
      muted
      loop
      playsInline
      preload="none"
      controls={still}
    />
  );
}
