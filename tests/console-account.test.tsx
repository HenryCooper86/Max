// @vitest-environment happy-dom
// The console's account area and reset page: change password, sign out
// everywhere, and the page a password-reset link opens.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleApp } from "../src/console/ConsoleApp";
import { isResetPath, resetTokenFromLocation } from "../src/console/ResetPasswordCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = `mcr_${"a".repeat(43)}`;
const INVALID = "This link is not valid: it may have been used or have expired. Ask for a new one.";

let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
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

const render = (node: React.ReactNode) =>
  act(async () => {
    root!.render(node);
  });
const click = (element: HTMLElement) =>
  act(async () => {
    element.click();
  });
/** Flushes the pending network promise and the state changes that follow it. */
const settle = () =>
  act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  });
const setInput = (input: HTMLInputElement, value: string) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const submit = (form: HTMLFormElement) =>
  act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

function navigate(url: string) {
  // happy-dom's Window exposes this; the DOM lib types do not know it.
  const windowApi = window as unknown as { happyDOM: { setURL(value: string): void } };
  windowApi.happyDOM.setURL(url);
}

type Recorded = { url: string; method: string; body?: Record<string, unknown> };

/** Installs a fetch that answers each URL, and records what was sent. */
function stubFetch(answer: (url: string) => Response) {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({
        url: input,
        method: init?.method ?? "GET",
        ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {})
      });
      return answer(input);
    })
  );
  return calls;
}

const me = {
  customer: { id: "c1", email: "dev@example.com", createdAt: 1 },
  balance: { fen: 0, freeSecondsLeft: 60_000, month: "2026-11" }
};

const dashboardAnswers = (url: string) =>
  url.endsWith("/me")
    ? Response.json(me)
    : url.endsWith("/projects")
      ? Response.json({ projects: [] })
      : url.endsWith("/usage")
        ? Response.json({ month: "2026-11", seconds: 0, minutes: 0, freeSecondsUsed: 0, chargedFen: 0, projects: [] })
        : url.endsWith("/ledger")
          ? Response.json({ entries: [] })
          : url.endsWith("/password")
            ? Response.json({ ok: true })
            : url.endsWith("/logout-everywhere")
              ? Response.json({ ok: true })
              : url.endsWith("/packs")
                ? Response.json({ packs: [], providers: [] })
                : Response.json({});

async function renderSignedIn(answer = dashboardAnswers) {
  localStorage.setItem("max.cloud.token.v1", "mcs_t");
  const calls = stubFetch(answer);
  await render(<ConsoleApp />);
  await settle();
  return calls;
}

describe("the account area", () => {
  it("shows who is signed in and changes the password once the current one is right", async () => {
    const calls = await renderSignedIn();
    const account = host.querySelector<HTMLElement>("#account")!;
    expect(account.textContent).toContain("账户");
    expect(account.textContent).toContain("已登录：dev@example.com");
    expect(account.textContent).toContain("修改密码");
    expect(account.textContent).toContain("在所有设备上退出登录");

    const form = account.querySelector("form")!;
    const current = account.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!;
    const next = account.querySelector<HTMLInputElement>('input[autocomplete="new-password"]')!;
    await setInput(current, "old password");
    await setInput(next, "a brand new password");
    await submit(form);
    await settle();

    const sent = calls.find((call) => call.url.endsWith("/password"))!;
    expect(sent.method).toBe("POST");
    expect(sent.body).toEqual({ currentPassword: "old password", newPassword: "a brand new password" });
    expect(account.textContent).toContain("密码已修改。");
    expect(current.value).toBe("");
    expect(next.value).toBe("");
  });

  it("keeps the signed-in session and shows the reason when the current password is wrong", async () => {
    const calls = await renderSignedIn((url) =>
      url.endsWith("/password")
        ? new Response(JSON.stringify({ ok: false, error: "The current password is wrong." }), { status: 400 })
        : dashboardAnswers(url)
    );
    const account = host.querySelector<HTMLElement>("#account")!;
    const form = account.querySelector("form")!;
    await setInput(
      account.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!,
      "wrong password"
    );
    await setInput(
      account.querySelector<HTMLInputElement>('input[autocomplete="new-password"]')!,
      "a brand new password"
    );
    await submit(form);
    await settle();
    expect(account.textContent).toContain("The current password is wrong.");
    expect(host.querySelector("#account")).not.toBeNull();
    expect(calls.some((call) => call.url.endsWith("/logout-everywhere"))).toBe(false);
  });

  it("signs out everywhere after a confirm, which opens on its safe choice and returns the focus to its button", async () => {
    const calls = await renderSignedIn();
    const toggle = host.querySelector<HTMLButtonElement>("#account button[aria-expanded]")!;
    await click(toggle);
    // The confirm group's safe choice (Cancel) holds the focus, and nothing was sent yet.
    expect(host.textContent).toContain("是，全部退出");
    expect(document.activeElement?.textContent).toContain("取消");
    expect(calls.some((call) => call.url.endsWith("/logout-everywhere"))).toBe(false);

    const cancel = host.querySelector<HTMLButtonElement>("#cx-sign-out-everywhere button.quiet")!;
    await click(cancel);
    expect(document.activeElement).toBe(toggle);
    expect(host.querySelector("#cx-sign-out-everywhere")).toBeNull();

    await click(toggle);
    const confirm = host.querySelector<HTMLButtonElement>("#cx-sign-out-everywhere button.cxDangerButton")!;
    await click(confirm);
    await settle();

    const sent = calls.find((call) => call.url.endsWith("/logout-everywhere"))!;
    expect(sent.method).toBe("POST");
    expect(sent.body).toBeUndefined();
    // The stored session is gone, and the log-in card says why, with the focus on the notice.
    expect(localStorage.getItem("max.cloud.token.v1")).toBeNull();
    expect(host.textContent).toContain("已在所有设备上退出登录。");
    expect(host.querySelector(".cxNotice")).toBe(document.activeElement);
  });
});

describe("the reset page", () => {
  it("sets a new password with the link's token, then returns to the log-in card with the notice", async () => {
    navigate(`http://localhost/console/reset?token=${TOKEN}`);
    const calls = stubFetch((url) =>
      url.endsWith("/reset-password")
        ? Response.json({ ok: true, email: "dev@example.com" })
        : url.endsWith("/packs")
          ? Response.json({ packs: [], providers: [] })
          : Response.json({})
    );
    const replaceState = vi.spyOn(window.history, "replaceState");
    await render(<ConsoleApp />);

    expect(host.textContent).toContain("设置新密码");
    const [password, confirmation] = host.querySelectorAll<HTMLInputElement>('input[type="password"]');
    await setInput(password!, "a brand new password");
    await setInput(confirmation!, "a brand new password");
    await submit(host.querySelector("form")!);
    await settle();

    const sent = calls.find((call) => call.url.endsWith("/reset-password"))!;
    expect(sent.method).toBe("POST");
    expect(sent.body).toEqual({ token: TOKEN, newPassword: "a brand new password" });
    // The link is used up: the token is out of the address bar, the notice is read, and the email is filled in.
    expect(replaceState).toHaveBeenCalledWith(null, "", "/console");
    expect(host.textContent).toContain("密码已修改。请用新密码登录 dev@example.com。");
    expect(document.activeElement).toBe(host.querySelector(".cxNotice"));
    expect(host.querySelector<HTMLInputElement>('input[autocomplete="email"]')!.value).toBe("dev@example.com");
    expect(localStorage.getItem("max.cloud.token.v1")).toBeNull();
  });

  it("turns an unknown, used or expired link into one refusal, without a form", async () => {
    navigate(`http://localhost/console/reset?token=${TOKEN}`);
    stubFetch((url) =>
      url.endsWith("/reset-password")
        ? new Response(JSON.stringify({ ok: false, error: INVALID }), { status: 403 })
        : Response.json({})
    );
    await render(<ConsoleApp />);
    const [password, confirmation] = host.querySelectorAll<HTMLInputElement>('input[type="password"]');
    await setInput(password!, "a brand new password");
    await setInput(confirmation!, "a brand new password");
    await submit(host.querySelector("form")!);
    await settle();
    expect(host.querySelector("form")).toBeNull();
    expect(host.textContent).toContain("这个链接无效：可能已经用过，或者已过期。");
    expect(host.textContent).toContain("需要新的链接，请联系运营这台 Max Cloud 的人。");
    expect(host.textContent).toContain("返回登录");
    // The focused submit button is gone: the focus moves to the refusal, not the page behind it.
    expect(document.activeElement).toBe(host.querySelector('p[role="alert"]'));
  });

  it("refuses a page without a token without asking the relay", async () => {
    navigate("http://localhost/console/reset");
    const calls = stubFetch(() => Response.json({}));
    await render(<ConsoleApp />);
    expect(host.querySelector("form")).toBeNull();
    expect(host.textContent).toContain("这个链接无效：可能已经用过，或者已过期。");
    expect(calls.some((call) => call.url.endsWith("/reset-password"))).toBe(false);
  });

  it("speaks English when the visitor chose it", async () => {
    localStorage.setItem("max.ui.language.v1", "en-US");
    navigate(`http://localhost/console/reset?token=${TOKEN}`);
    stubFetch(() => Response.json({}));
    await render(<ConsoleApp />);
    expect(host.textContent).toContain("Set a new password");
    expect(host.textContent).toContain("Repeat the new password");
  });
});

describe("the reset path", () => {
  it("recognises the page and its token", () => {
    expect(isResetPath("/console/reset")).toBe(true);
    expect(isResetPath("/console/reset/")).toBe(true);
    expect(isResetPath("/console")).toBe(false);
    expect(isResetPath("/console/resets")).toBe(false);
    expect(resetTokenFromLocation(`?token=${TOKEN}`)).toBe(TOKEN);
    expect(resetTokenFromLocation("?token=garbage")).toBe("");
    expect(resetTokenFromLocation("")).toBe("");
  });
});
