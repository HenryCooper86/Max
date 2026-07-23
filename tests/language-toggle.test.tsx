import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider, LanguageToggle, useLanguage } from "../src/components/LanguageToggle";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  const { t } = useLanguage();
  return <p>{t("settings.title")}</p>;
}

describe("LanguageToggle", () => {
  let renderer: ReactTestRenderer | undefined;

  afterEach(() => {
    renderer?.unmount();
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("switches the provider copy immediately and persists the choice", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", { localStorage: { getItem: () => null, setItem } });

    act(() => {
      renderer = create(
        <LanguageProvider>
          <LanguageToggle />
          <Probe />
        </LanguageProvider>
      );
    });

    expect(renderer!.root.findByType("p").children.join("")).toBe("设置");
    const english = renderer!.root.find((node) => node.type === "button" && node.props["aria-pressed"] === false);
    act(() => english.props.onClick());
    expect(renderer!.root.findByType("p").children.join("")).toBe("Settings");
    expect(setItem).toHaveBeenCalledWith("max.ui.language.v1", "en-US");
  });
});
