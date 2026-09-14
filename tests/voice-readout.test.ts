import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VoiceStateReadout } from "../src/components/HelmetVisual";

describe("voice session readout", () => {
  it("gives an inactive session a clear first action", () => {
    const html = renderToStaticMarkup(
      createElement(VoiceStateReadout, { connected: false, turnState: "idle", sessionState: "inactive" })
    );
    expect(html).toContain("你好，我是 MAX");
    expect(html).toContain("开启免提");
    expect(html).not.toContain("OFFLINE");
  });

  it("explains pending setup and cancellation", () => {
    const html = renderToStaticMarkup(
      createElement(VoiceStateReadout, { connected: false, turnState: "idle", sessionState: "starting" })
    );
    expect(html).toContain("正在连接免提");
    expect(html).toContain("再次点击取消");
  });

  it("keeps disconnected sessions and live hazards distinct from welcome guidance", () => {
    expect(
      renderToStaticMarkup(createElement(VoiceStateReadout, { connected: false, turnState: "listening" }))
    ).toContain("OFFLINE");
    const html = renderToStaticMarkup(
      createElement(VoiceStateReadout, {
        connected: true,
        turnState: "listening",
        hazardLevel: "critical",
        sessionState: "inactive"
      })
    );
    expect(html).toContain("HAZARD");
    expect(html).not.toContain("你好，我是 MAX");
  });
});
