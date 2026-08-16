// Measures the real HUD layout in headless Chrome.
//
// The voice shell's hardest bugs are geometric — a guidance card clipped into
// a zero-height grid row, controls pushed past the fold, captions drawn on top
// of the turn instruction — and none of them are visible to this repo's test
// runner: vitest has no browser, and `react-test-renderer` never applies CSS.
// Every one of those defects therefore shipped.
//
// The components under test are server-rendered from production source rather
// than hand-copied into a fixture, so a change to the guidance card is a
// change to what this measures. Only the surrounding furniture (top bar, hero,
// utilities, dock) is reproduced here, because it lives inline in App.tsx and
// cannot render without the whole authenticated app — see SHELL_FIDELITY.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "../../src/components/LanguageToggle";
import { NavigationPanel } from "../../src/components/NavigationPanel";
import { VoiceTranscript } from "../../src/components/VoiceTranscript";
import { voiceFaceClassName } from "../../src/lib/voice-shell";
import type { HelmetAgent } from "../../src/hooks/useHelmetAgent";
import type { NavPhase } from "../../src/lib/navigation";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** The furniture below is copied, not rendered. If AgentScreen's voice shell
 *  gains or loses a direct child, update this too or the measurements drift
 *  away from production without failing. */
const SHELL_FIDELITY = "topbar, hero, readout, [nav], [captions], utilities, dock";

export type ProbeOptions = {
  width: number;
  height: number;
  nav: NavPhase | null;
  captions: boolean;
};

type Box = { top: number; bottom: number; left: number; right: number; height: number };

export type ProbeResult = {
  viewport: { width: number; height: number };
  shellOverflowPx: number;
  dockOnScreen: boolean;
  navPanel: (Box & { clippedPx: number }) | null;
  transcript: (Box & { clippedPx: number }) | null;
  navOverlapsTranscript: boolean;
};

function transcriptAgent(): HelmetAgent {
  // Only the fields VoiceTranscript reads while rendering.
  return {
    transcript: [
      { id: 1, at: Date.now(), text: "你好，Max。", speaker: "rider", final: true, language: "zh" },
      { id: 2, at: Date.now(), text: "已为你规划路线。", speaker: "agent", final: true, language: "zh" },
      { id: 3, at: Date.now(), text: "前方 180 米右转。", speaker: "agent", final: true, language: "zh" }
    ],
    sendTurnFeedback: () => false,
    // True so the flag affordance renders: it is the tallest variant of a
    // transcript row, and this suite measures heights.
    canFlagTurn: () => true
  } as unknown as HelmetAgent;
}

function markup(node: Parameters<typeof renderToStaticMarkup>[0]): string {
  return renderToStaticMarkup(createElement(LanguageProvider, null, node));
}

function harnessHtml(css: string, options: ProbeOptions): string {
  const navHtml = options.nav
    ? markup(createElement(NavigationPanel, { state: options.nav, mapConsent: "unknown" }))
    : "";
  const transcriptHtml = options.captions ? markup(createElement(VoiceTranscript, { agent: transcriptAgent() })) : "";

  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8" />
<style>${css}</style></head>
<body>
<main class="voiceShell">
  <section class="${voiceFaceClassName({ captionsOpen: options.captions, navigationVisible: Boolean(options.nav) })}">
    <!-- ${SHELL_FIDELITY} -->
    <header class="voiceTopbar offline">
      <div class="voiceBrand"><span class="voiceBrandDot"></span><span class="voiceWordmark">MAX</span></div>
      <div class="voiceRelay"><span class="voiceRelayDot"></span>RELAY OFFLINE</div>
    </header>
    <div class="voiceHero"><div class="helmetStage"><div style="width:100%;height:100%"></div></div></div>
    <div class="voiceReadout"><strong>点按头盔，开始对话</strong><span>STANDBY</span></div>
    ${navHtml}
    ${transcriptHtml}
    <nav class="voiceUtilities"><button type="button">字幕</button><button type="button">相册</button><button type="button">设置</button></nav>
    <div class="voicePrimaryControls"><button type="button" class="voicePrimaryButton">开启免提</button></div>
  </section>
</main>
<pre id="probe-result"></pre>
<script>
  addEventListener("load", () => {
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height,
               clippedPx: el.scrollHeight - el.clientHeight };
    };
    const face = document.querySelector(".voiceFace");
    const faceRect = face.getBoundingClientRect();
    const contentBottom = faceRect.bottom - parseFloat(getComputedStyle(face).paddingBottom);
    const last = face.lastElementChild.getBoundingClientRect();
    const dock = document.querySelector(".voicePrimaryControls").getBoundingClientRect();
    const nav = box(document.querySelector(".navigationPanel"));
    const tr = box(document.querySelector(".voiceTranscript"));
    const overlaps = Boolean(nav && tr)
      && Math.min(nav.bottom, tr.bottom) - Math.max(nav.top, tr.top) > 1
      && Math.min(nav.right, tr.right) - Math.max(nav.left, tr.left) > 1;

    document.querySelector("#probe-result").textContent = JSON.stringify({
      viewport: { width: innerWidth, height: innerHeight },
      shellOverflowPx: Math.round(last.bottom - contentBottom),
      dockOnScreen: dock.bottom <= innerHeight + 0.5,
      navPanel: nav, transcript: tr, navOverlapsTranscript: overlaps
    });
  });
</script>
</body></html>`;
}

let cachedCss: string | null = null;

function stylesheet(): string {
  if (cachedCss === null) {
    const here = fileURLToPath(new URL(".", import.meta.url));
    cachedCss = readFileSyncUtf8(join(here, "..", "..", "src", "styles.css"));
  }
  return cachedCss;
}

function readFileSyncUtf8(path: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:fs").readFileSync(path, "utf8") as string;
}

/** Renders the shell at a viewport and returns what Chrome actually laid out. */
export function probeHudLayout(options: ProbeOptions): ProbeResult {
  const dir = mkdtempSync(join(tmpdir(), "hud-layout-"));
  const page = join(dir, "harness.html");
  writeFileSync(page, harnessHtml(stylesheet(), options), "utf8");

  const chrome = spawnSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--virtual-time-budget=3000",
      `--window-size=${options.width},${options.height}`,
      "--dump-dom",
      `file://${page}`
    ],
    { encoding: "utf8", timeout: 60_000 }
  );

  const dom = chrome.stdout ?? "";
  const match = /<pre id="probe-result">([\s\S]*?)<\/pre>/.exec(dom);
  if (!match || !match[1].trim()) {
    throw new Error(
      `headless Chrome returned no measurements (status ${chrome.status}): ${chrome.stderr?.slice(0, 400) ?? ""}`
    );
  }
  // --dump-dom escapes the JSON's quotes into entities.
  const json = match[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  return JSON.parse(json) as ProbeResult;
}

export function chromeAvailable(): boolean {
  return existsSync(CHROME);
}
