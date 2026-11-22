/**
 * Live video for the agent: a camera, a shared screen or a stream the page
 * already has, read a frame at a time. The browser parts sit behind
 * {@link VideoOpener} so tests can run without a camera.
 */

import type { ImageSource } from "./image.js";

/** What `startVideo` can show the agent: the camera, the screen, or a stream of the page's own. */
export type VideoSource = "camera" | "screen" | MediaStream;

/** What is being shown. `stream` is a `MediaStream` the page passed in. */
export type VideoKind = "camera" | "screen" | "stream";

/** Options of `startVideo`. */
export type VideoOptions = {
  /** Time between two frames, in milliseconds. 1000 by default; the relay takes none under 500. */
  intervalMs?: number;
  /** Longer side of a frame, in pixels. 768 by default. */
  maxSide?: number;
  /** Which camera a phone uses: the one facing the user (the default) or the one facing away. */
  facingMode?: "user" | "environment";
};

/** One opened video: its stream, for a preview, and where its frames are read. */
export interface OpenedVideo {
  stream: MediaStream;
  /** What the newest frame is drawn from. Undefined while the video has no pixels yet. */
  frame(): ImageSource | undefined;
  /** Tells when the video ends by itself: the browser's "Stop sharing", a camera unplugged. */
  onEnded(listener: () => void): void;
  /** Lets the video go. A camera or screen this opened is turned off; a stream the page passed in is left running. */
  close(): void;
}

/** @internal */
export type VideoOpener = (source: VideoSource, options: VideoOptions) => Promise<OpenedVideo>;

export const DEFAULT_VIDEO_INTERVAL_MS = 1000;
export const DEFAULT_VIDEO_MAX_SIDE = 768;
/** Lower than a picture's: a frame is one of many, and the next is a second away. */
export const VIDEO_QUALITIES = [0.6, 0.45];

export function videoKind(source: VideoSource): VideoKind {
  return source === "camera" || source === "screen" ? source : "stream";
}

/** The real thing: `getUserMedia` or `getDisplayMedia`, played in a video element nobody sees. */
export const openVideoInBrowser: VideoOpener = async (source, options) => {
  const media = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  let stream: MediaStream;
  if (source === "camera") {
    if (!media?.getUserMedia) throw new Error("this browser gives the page no camera");
    stream = await media.getUserMedia({
      audio: false,
      video: { facingMode: options.facingMode ?? "user", width: { ideal: 1280 }, height: { ideal: 720 } }
    });
  } else if (source === "screen") {
    if (!media?.getDisplayMedia) throw new Error("this browser cannot share the screen");
    stream = await media.getDisplayMedia({ audio: false, video: true });
  } else stream = source;
  const own = source === "camera" || source === "screen";
  const release = () => {
    if (own) for (const track of stream.getTracks()) track.stop();
  };
  const track = stream.getVideoTracks()[0];
  if (!track) {
    release();
    throw new Error("the stream has no video");
  }
  const element = document.createElement("video");
  element.muted = true;
  element.playsInline = true;
  element.srcObject = stream;
  // A video that cannot play yet has no frames, and frame() says so.
  void element.play().catch(() => undefined);
  let ended: (() => void) | undefined;
  return {
    stream,
    frame: () => (element.readyState >= 2 && element.videoWidth > 0 && element.videoHeight > 0 ? element : undefined),
    onEnded(listener) {
      ended = listener;
      track.addEventListener("ended", listener, { once: true });
    },
    close() {
      if (ended) track.removeEventListener("ended", ended);
      element.pause();
      element.srcObject = null;
      release();
    }
  };
};
