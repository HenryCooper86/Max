import { act } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HelmetVisual, VoiceStateReadout } from "../src/components/HelmetVisual";
import { LanguageProvider } from "../src/components/LanguageToggle";
import { LoginGate } from "../src/components/LoginGate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === "string" ? child : text(child))).join("");
}

describe("translated UI surfaces", () => {
  let renderer: ReactTestRenderer | undefined;

  afterEach(() => {
    renderer?.unmount();
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("renders the login gate and voice state in English without changing voice behavior", () => {
    vi.stubGlobal("window", {
      location: { search: "" },
      localStorage: { getItem: () => "en-US" }
    });
    act(() => {
      renderer = create(
        <LanguageProvider>
          <LoginGate authEnabled registrationOpen onSignedIn={vi.fn()} />
          <VoiceStateReadout connected turnState="listening" />
          <HelmetVisual connected listening={false} voiceLevel={0} turnState="idle" />
        </LanguageProvider>
      );
    });
    const rendered = text(renderer!.root);
    expect(rendered).toContain("Internal testing platform");
    expect(rendered).toContain("Hands-free ready · speak now");
    expect(rendered).not.toContain("Max 思考中");
  });
});
