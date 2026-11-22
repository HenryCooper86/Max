/**
 * Turns whatever the page has (a file, a canvas, a video frame) into the JPEG
 * that `image.input` carries: scaled down, and small enough for the relay's
 * limit. The browser parts sit behind {@link ImageEncoder} so tests can run
 * without a canvas.
 */

import { MAX_IMAGE_BASE64_CHARS } from "./protocol.js";

/** What `sendImage` accepts. A string is a `data:` URL. */
export type ImageSource = Blob | File | HTMLCanvasElement | HTMLImageElement | HTMLVideoElement | ImageBitmap | string;

/** One opened source: its pixel size, and a way to draw it at another size as JPEG. */
interface OpenedImage {
  width: number;
  height: number;
  /** JPEG as base64 without a `data:` prefix. */
  encode(width: number, height: number, quality: number): Promise<string>;
  close?(): void;
}

/** @internal */
export type ImageEncoder = (source: ImageSource) => Promise<OpenedImage>;

export const DEFAULT_IMAGE_MAX_SIDE = 1024;
/** Tried in turn at each size before the size itself is lowered. */
const QUALITIES = [0.85, 0.7, 0.55];
const SHRINK = 0.75;
const MIN_SIDE = 64;

/**
 * Scales the source so its longer side is at most `maxSide`, encodes it as
 * JPEG, and lowers quality and then size until the base64 fits the relay's
 * limit. Rejects when even the smallest size does not fit.
 */
export async function encodeImage(
  source: ImageSource,
  maxSide: number | undefined,
  open: ImageEncoder = openInBrowser
): Promise<string> {
  const limit =
    Number.isFinite(maxSide) && (maxSide as number) >= MIN_SIDE
      ? Math.floor(maxSide as number)
      : DEFAULT_IMAGE_MAX_SIDE;
  const image = await open(source);
  try {
    const longest = Math.max(image.width, image.height);
    if (!(longest > 0)) throw new Error("the image has no pixels (a video that has not started?)");
    let side = Math.min(limit, longest);
    // The first size is always tried, even a tiny picture's own.
    for (;;) {
      const scale = side / longest;
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      for (const quality of QUALITIES) {
        const data = await image.encode(width, height, quality);
        if (data.length <= MAX_IMAGE_BASE64_CHARS) return data;
      }
      side = Math.floor(side * SHRINK);
      if (side < MIN_SIDE) break;
    }
    throw new Error(`the image does not fit in ${MAX_IMAGE_BASE64_CHARS} characters even at ${MIN_SIDE} pixels`);
  } finally {
    image.close?.();
  }
}

type Drawable = CanvasImageSource & { close?(): void };

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  // Chunked: spreading a whole picture into one call overflows the stack.
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

async function toDrawable(
  source: ImageSource
): Promise<{ drawable: Drawable; width: number; height: number; own: boolean }> {
  if (typeof source === "string") {
    if (!source.startsWith("data:")) throw new Error("a string must be a data: URL");
    return toDrawable(await (await fetch(source)).blob());
  }
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    const bitmap = await createImageBitmap(source);
    return { drawable: bitmap, width: bitmap.width, height: bitmap.height, own: true };
  }
  if (typeof HTMLVideoElement !== "undefined" && source instanceof HTMLVideoElement) {
    return { drawable: source, width: source.videoWidth, height: source.videoHeight, own: false };
  }
  if (typeof HTMLImageElement !== "undefined" && source instanceof HTMLImageElement) {
    return { drawable: source, width: source.naturalWidth, height: source.naturalHeight, own: false };
  }
  const sized = source as HTMLCanvasElement | ImageBitmap;
  return { drawable: sized, width: sized.width, height: sized.height, own: false };
}

/** The real thing: a canvas, `OffscreenCanvas` where the browser has it. */
const openInBrowser: ImageEncoder = async (source) => {
  const { drawable, width, height, own } = await toDrawable(source);
  return {
    width,
    height,
    async encode(targetWidth, targetHeight, quality) {
      let blob: Blob | null;
      if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(targetWidth, targetHeight);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("the browser gave no 2D canvas");
        // JPEG has no transparency: a transparent PNG would turn black.
        context.fillStyle = "#fff";
        context.fillRect(0, 0, targetWidth, targetHeight);
        context.drawImage(drawable, 0, 0, targetWidth, targetHeight);
        blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
      } else {
        const canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("the browser gave no 2D canvas");
        context.fillStyle = "#fff";
        context.fillRect(0, 0, targetWidth, targetHeight);
        context.drawImage(drawable, 0, 0, targetWidth, targetHeight);
        blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      }
      if (!blob) throw new Error("the browser could not encode JPEG");
      return blobToBase64(blob);
    },
    close() {
      if (own) drawable.close?.();
    }
  };
};
