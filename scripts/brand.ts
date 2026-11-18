import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { devicePreset } from "../server/device-presets";

/**
 * `npm run brand` — one logo in, every product's icons out.
 *
 * The in-app mark and the page favicon follow assistant.config.json's `logo`
 * at runtime (the relay serves it). App icons cannot: iOS and Android bake
 * them in at build time, and browsers want an .ico and a touch icon on disk.
 * This writes all of those from the same file, so the web app, the iOS app
 * and the Android app carry the same mark:
 *
 *   public/favicon.svg, favicon.ico, apple-touch-icon.png
 *   ios/…/AppIcon.appiconset/AppIcon.png            (1024, opaque)
 *   android/…/res/mipmap-*dpi/ic_launcher_foreground.png + launcher background
 *
 * Source: the path given on the command line, else `logo` in
 * assistant.config.json, else the mark of the configured `device`
 * (brand/devices/<device>.svg — a helmet for a helmet, glasses for glasses).
 * A square SVG is best; a square PNG of 1024 px or more also works.
 * Needs `rsvg-convert` (librsvg) and `magick` (ImageMagick) on the PATH.
 */

const root = process.cwd();

type BrandSource = { file: string; background: string };

/** Where the logo comes from and what goes behind it. Exported for tests. */
export function resolveBrandSource(
  argument: string | undefined,
  configText: string | undefined,
  cwd: string
): BrandSource {
  let background = "#0B0C0E";
  let configured: string | undefined;
  let device: unknown;
  if (configText) {
    try {
      const config = JSON.parse(configText) as { logo?: unknown; logoBackground?: unknown; device?: unknown };
      device = config.device;
      if (typeof config.logo === "string" && config.logo.trim()) configured = config.logo.trim();
      if (typeof config.logoBackground === "string" && /^#[0-9a-f]{6}$/i.test(config.logoBackground.trim())) {
        background = config.logoBackground.trim().toUpperCase();
      }
    } catch {
      /* an unreadable config means the defaults */
    }
  }
  return {
    // Stock Max's mark is the hummingbird; a configured device brings its own.
    file: path.resolve(
      cwd,
      argument ??
        configured ??
        (device === undefined ? "brand/hummingbird.svg" : `brand/devices/${devicePreset(device).id}.svg`)
    ),
    background
  };
}

/** Android adaptive-icon foreground sizes: 108 dp at each density. */
export const ANDROID_FOREGROUNDS: ReadonlyArray<[density: string, pixels: number]> = [
  ["mdpi", 108],
  ["hdpi", 162],
  ["xhdpi", 216],
  ["xxhdpi", 324],
  ["xxxhdpi", 432]
];

/** The launcher mask can crop to the middle 66 dp of the 108 dp canvas, so an
 *  owner's logo is drawn inside that and no launcher shape can cut into it.
 *  The built-in device marks already carry their own margin (the drawing sits
 *  in the middle 60% of its square), so they are drawn larger to match. */
export function androidLogoSize(canvas: number, builtInMark = false): number {
  return Math.round((canvas * (builtInMark ? 92 : 66)) / 108);
}

function need(tool: string, hint: string): void {
  try {
    execFileSync(tool, ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(`"${tool}" was not found. Install it first: ${hint}`);
  }
}

function main(): void {
  let configText: string | undefined;
  try {
    configText = fs.readFileSync(path.join(root, "assistant.config.json"), "utf8");
  } catch {
    /* no config: built-in mark */
  }
  const source = resolveBrandSource(process.argv[2], configText, root);
  const extension = path.extname(source.file).toLowerCase();
  if (!fs.existsSync(source.file)) throw new Error(`Logo not found: ${source.file}`);
  if (extension !== ".svg" && extension !== ".png") throw new Error("The logo must be an .svg or .png file.");
  need("magick", "brew install imagemagick  (or: apt install imagemagick)");
  if (extension === ".svg") need("rsvg-convert", "brew install librsvg  (or: apt install librsvg2-bin)");

  const builtInMark = path.dirname(source.file) === path.join(root, "brand", "devices");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "brand-"));
  /** The logo as a transparent-background PNG of the given size. */
  const render = (pixels: number): string => {
    const out = path.join(work, `logo-${pixels}.png`);
    if (!fs.existsSync(out)) {
      if (extension === ".svg") {
        execFileSync("rsvg-convert", ["-w", String(pixels), "-h", String(pixels), source.file, "-o", out]);
      } else {
        execFileSync("magick", [source.file, "-resize", `${pixels}x${pixels}`, out]);
      }
    }
    return out;
  };
  /** The logo on an opaque background: what iOS and the touch icon require. */
  const opaque = (pixels: number, out: string): void => {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    execFileSync("magick", [
      render(pixels),
      "-background",
      source.background,
      "-alpha",
      "remove",
      "-alpha",
      "off",
      out
    ]);
  };
  const written: string[] = [];
  const note = (file: string) => written.push(path.relative(root, file));

  // Web.
  const publicDir = path.join(root, "public");
  const faviconSvg = path.join(publicDir, "favicon.svg");
  if (extension === ".svg") {
    fs.copyFileSync(source.file, faviconSvg);
  } else {
    const data = fs.readFileSync(render(256)).toString("base64");
    fs.writeFileSync(
      faviconSvg,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><image width="256" height="256" href="data:image/png;base64,${data}" /></svg>\n`
    );
  }
  note(faviconSvg);
  const ico = path.join(publicDir, "favicon.ico");
  execFileSync("magick", [render(16), render(32), render(48), ico]);
  note(ico);
  const touch = path.join(publicDir, "apple-touch-icon.png");
  opaque(180, touch);
  note(touch);

  // iOS: one 1024 px opaque image; Xcode derives the rest.
  const iosIcon = path.join(root, "ios/MaxHelmet/Assets.xcassets/AppIcon.appiconset/AppIcon.png");
  if (fs.existsSync(path.dirname(iosIcon))) {
    opaque(1024, iosIcon);
    note(iosIcon);
  }

  // Android: adaptive-icon foregrounds, with the launcher background colour.
  const res = path.join(root, "android/app/src/main/res");
  if (fs.existsSync(res)) {
    for (const [density, canvas] of ANDROID_FOREGROUNDS) {
      const out = path.join(res, `mipmap-${density}`, "ic_launcher_foreground.png");
      fs.mkdirSync(path.dirname(out), { recursive: true });
      execFileSync("magick", [
        "-size",
        `${canvas}x${canvas}`,
        "xc:none",
        render(androidLogoSize(canvas, builtInMark)),
        "-gravity",
        "center",
        "-composite",
        out
      ]);
      note(out);
    }
    const colors = path.join(res, "values/colors.xml");
    const before = fs.readFileSync(colors, "utf8");
    const after = before.replace(/(<color name="ic_launcher_background">)[^<]*(<\/color>)/, `$1${source.background}$2`);
    if (after !== before) {
      fs.writeFileSync(colors, after);
      note(colors);
    }
  }

  fs.rmSync(work, { recursive: true, force: true });
  console.log(`Logo: ${path.relative(root, source.file)}  ·  background ${source.background}`);
  for (const file of written) console.log(`  wrote ${file}`);
  console.log("\nRebuild the web app and reinstall the mobile apps to see the new icons.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
