import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantProvider } from "../src/components/AssistantContext";
import { LanguageProvider } from "../src/components/LanguageToggle";
import { VoiceStateReadout } from "../src/components/VisorVisual";
import { accentTokens, DEFAULT_ASSISTANT, resolveAssistant } from "../src/lib/assistant";

describe("assistant branding", () => {
  it("falls back to the built-in Max helmet assistant when the relay sends nothing", () => {
    expect(resolveAssistant(undefined)).toEqual(DEFAULT_ASSISTANT);
    expect(
      renderToStaticMarkup(<VoiceStateReadout connected={false} turnState="idle" sessionState="inactive" />)
    ).toContain("你好，我是 Max");
  });

  it("names the assistant and picks device copy from the relay summary", () => {
    const assistant = resolveAssistant({
      name: "Iris",
      device: "glasses",
      wakePhrase: "Hey Iris",
      wakeWordEnabled: true,
      accentColor: "#7aa7ff",
      languages: ["en"]
    });
    expect(assistant.accentColor).toBe("#7AA7FF");

    const welcome = renderToStaticMarkup(
      <LanguageProvider>
        <AssistantProvider value={assistant}>
          <VoiceStateReadout connected={false} turnState="idle" sessionState="inactive" />
        </AssistantProvider>
      </LanguageProvider>
    );
    expect(welcome).toContain("你好，我是 Iris");
    expect(welcome).not.toContain("骑行");

    const live = renderToStaticMarkup(
      <AssistantProvider value={assistant}>
        <VoiceStateReadout connected turnState="listening" />
      </AssistantProvider>
    );
    expect(live).toContain("Hey Iris");
  });

  it("ignores an accent that is not #RRGGBB and keeps a readable ink on the accent", () => {
    expect(resolveAssistant({ ...DEFAULT_ASSISTANT, accentColor: "lime", languages: [] }).accentColor).toBeUndefined();
    expect(accentTokens("#C6F432")?.onAccent).toBe("#0B0C0E");
    expect(accentTokens("#1E3A8A")?.onAccent).toBe("#FFFFFF");
    expect(accentTokens("#C6F432")?.accentSoft).toBe("rgba(198, 244, 50, 0.14)");
  });
});
