// @vitest-environment happy-dom
// What keyboard and assistive-technology users get from the console and the
// site header: which language the document says it is in, where focus goes
// while the top-up dialog is open, and the account card's tabs.
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider, LanguageToggle } from "../src/components/LanguageToggle";
import { AuthCard } from "../src/console/AuthCard";
import { createCloudApi, type Packs } from "../src/console/api";
import { ConsoleApp } from "../src/console/ConsoleApp";
import { TopUpDialog } from "../src/console/TopUpDialog";
import { LANGUAGE_STORAGE_KEY } from "../src/lib/i18n";
import { PublicSite } from "../src/landing/PublicSite";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  // As index.html ships, whatever an earlier test left behind.
  document.documentElement.lang = "zh-CN";
  localStorage.clear();
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  host.remove();
  vi.unstubAllGlobals();
});

const render = (node: ReactNode) =>
  act(async () => {
    root!.render(node);
  });
const click = (element: HTMLElement) =>
  act(async () => {
    element.click();
  });
const focus = (element: HTMLElement) =>
  act(async () => {
    element.focus();
  });
/** A key pressed on whatever has the focus. */
const press = async (key: string, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    document.activeElement?.dispatchEvent(event);
  });
  return event;
};
/** The language toggle's button for the language that is not showing. */
const otherLanguageButton = () =>
  host.querySelector<HTMLButtonElement>(".languageToggle button[aria-pressed='false']")!;

describe("the document's language", () => {
  it("follows the chosen language from the first render and on every switch", async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "en-US");
    await render(
      <LanguageProvider>
        <LanguageToggle />
      </LanguageProvider>
    );
    expect(document.documentElement.lang).toBe("en-US");
    await click(otherLanguageButton());
    expect(document.documentElement.lang).toBe("zh-CN");
    await click(otherLanguageButton());
    expect(document.documentElement.lang).toBe("en-US");
  });

  it("follows the language toggle on the console", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}))
    );
    await render(<ConsoleApp />);
    expect(document.documentElement.lang).toBe("zh-CN");
    await click(otherLanguageButton());
    expect(document.documentElement.lang).toBe("en-US");
  });

  it("follows the language toggle on the public site", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({}))
    );
    await render(<PublicSite view="landing" />);
    expect(document.documentElement.lang).toBe("zh-CN");
    await click(otherLanguageButton());
    expect(document.documentElement.lang).toBe("en-US");
  });
});

const PACKS: Packs = {
  packs: [
    { id: "cny10", fen: 1000 },
    { id: "cny50", fen: 5000 }
  ],
  providers: ["alipay", "wechat"]
};
// A top-up request that never answers, so the dialog stays busy.
const api = createCloudApi((path) =>
  path.endsWith("/packs")
    ? Promise.resolve(Response.json(PACKS))
    : path.endsWith("/topups")
      ? new Promise<Response>(() => undefined)
      : Promise.resolve(Response.json({}))
);

function TopUp() {
  // As the console's dashboard does: the dialog is told what opened it, so it
  // works for a mouse click too, which need not leave the button focused.
  const [opener, setOpener] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <button type="button" className="opener" onClick={(event) => setOpener(event.currentTarget)}>
        Top up
      </button>
      {opener ? (
        <TopUpDialog
          session={{ api, token: "t", fail: String }}
          opener={opener}
          onClose={() => setOpener(null)}
          onPaid={() => undefined}
        />
      ) : null}
    </>
  );
}

const openedDialog = async () => {
  await render(<TopUp />);
  const opener = host.querySelector<HTMLButtonElement>(".opener")!;
  await click(opener);
  const dialog = host.querySelector<HTMLElement>(".cxDialog")!;
  return {
    opener,
    dialog,
    close: dialog.querySelector<HTMLButtonElement>("button.quiet")!,
    proceed: dialog.querySelector<HTMLButtonElement>("button.siteButton:not(.quiet)")!
  };
};

describe("the top-up dialog", () => {
  it("opens with the focus on itself, keeps Tab and Shift+Tab inside, and returns the focus to its opener", async () => {
    const { opener, dialog, close, proceed } = await openedDialog();
    expect(document.activeElement).toBe(dialog);

    await press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(proceed);
    await press("Tab");
    expect(document.activeElement).toBe(close);
    await press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(proceed);

    // Focus that slipped out to the page behind is brought back in.
    await focus(opener);
    await press("Tab");
    expect(document.activeElement).toBe(close);
    await focus(opener);
    await press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(proceed);

    await press("Escape");
    expect(host.querySelector(".cxDialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes from the dimmed area around it, and not from inside it", async () => {
    const { opener, dialog } = await openedDialog();
    await click(dialog);
    expect(host.querySelector(".cxDialog")).not.toBeNull();
    await click(host.querySelector<HTMLElement>(".cxScrimClose")!);
    expect(host.querySelector(".cxDialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("returns the focus to its opener when it is closed with its button", async () => {
    const { opener, close } = await openedDialog();
    await focus(close);
    await click(close);
    expect(host.querySelector(".cxDialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("counts only the chosen button of a radio group as a Tab stop", async () => {
    const { close, proceed, dialog } = await openedDialog();
    const [alipay] = dialog.querySelectorAll<HTMLInputElement>("input[name='provider']");
    await click(proceed);
    // The request is pending: Continue is disabled, so the payment choices
    // are the last thing to reach, and only the chosen one is reachable.
    expect(proceed.disabled).toBe(true);
    await focus(alipay);
    await press("Tab");
    expect(document.activeElement).toBe(close);
    await press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(alipay);
  });
});

describe("the account card's tabs", () => {
  const tab = (mode: string) => host.querySelector<HTMLButtonElement>(`#cx-tab-${mode}`)!;
  const inTabOrder = () => Array.from(host.querySelectorAll('[role="tab"][tabindex="0"]')).map((element) => element.id);
  const selected = () => Array.from(host.querySelectorAll('[role="tab"][aria-selected="true"]')).map((tab) => tab.id);
  const panel = () => host.querySelector("#cx-auth-panel")!;

  it("moves and selects with the arrow keys and Home/End, with only the selected tab in the Tab order", async () => {
    await render(<AuthCard api={createCloudApi(async () => Response.json({}))} onSignedIn={() => undefined} />);
    expect(selected()).toEqual(["cx-tab-login"]);
    expect(inTabOrder()).toEqual(["cx-tab-login"]);
    expect(panel().getAttribute("aria-labelledby")).toBe("cx-tab-login");
    expect(tab("login").getAttribute("aria-controls")).toBe("cx-auth-panel");

    await focus(tab("login"));
    expect((await press("ArrowRight")).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tab("signup"));
    expect(selected()).toEqual(["cx-tab-signup"]);
    expect(inTabOrder()).toEqual(["cx-tab-signup"]);
    expect(panel().getAttribute("aria-labelledby")).toBe("cx-tab-signup");
    // The selected tab's panel is the one showing.
    expect(panel().querySelector('input[autocomplete="off"]')).not.toBeNull();

    // The ends wrap round.
    await press("ArrowRight");
    expect(document.activeElement).toBe(tab("login"));
    await press("ArrowLeft");
    expect(document.activeElement).toBe(tab("signup"));
    await press("End");
    expect(document.activeElement).toBe(tab("login"));
    await press("Home");
    expect(document.activeElement).toBe(tab("signup"));
    expect(selected()).toEqual(["cx-tab-signup"]);
    expect(inTabOrder()).toEqual(["cx-tab-signup"]);

    // Any other key is left to the button.
    expect((await press("Enter")).defaultPrevented).toBe(false);
    expect(selected()).toEqual(["cx-tab-signup"]);
  });
});
