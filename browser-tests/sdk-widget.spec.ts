import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The README's quick start, in a real browser: the example shop page loads the
 * widget from the relay with one script tag, mints a session token from its own
 * backend, opens the microphone (a fake device) and runs each kind of tool on
 * the keyless demo backend, which takes typed `tool {json}` turns.
 */

async function startConversation(page: Page): Promise<Locator> {
  // Microphone audio goes to the relay as binary WebSocket frames; JSON events go as text.
  let audioBytes = 0;
  page.on("websocket", (socket) =>
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") audioBytes += payload.length;
    })
  );
  const widget = page.locator("voice-agent");
  await widget.locator('[part="button"]').click();
  // The relay's greeting arrives only once the session is up, microphone included.
  await expect(widget.locator('[part="lines"]')).toContainText("Hi, I'm Ava", { timeout: 15_000 });
  await expect(widget.locator('[part="note"]')).toHaveText("");
  // The fake microphone's sound reaches the relay: about a second of 16 kHz PCM16 is 32,000 bytes.
  await expect.poll(() => audioBytes, { timeout: 10_000 }).toBeGreaterThan(32_000);
  return widget;
}

async function say(widget: Locator, text: string): Promise<void> {
  await widget.locator('[part="input"]').fill(text);
  await widget.locator('[part="send"]').click();
}

test("the script-tag widget talks to the relay and runs relay, webhook and page tools", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const widget = await startConversation(page);
  const lines = widget.locator('[part="lines"]');

  // A code tool inside the relay.
  await say(widget, 'check stock {"product": "Trail Runner 2"}');
  await expect(lines).toContainText('"inStock":14');

  // A webhook tool: the relay calls the shop's backend, which checks the signature.
  await say(widget, 'get_order_status {"orderId": "A-1042"}');
  await expect(lines).toContainText('"status":"shipped"');

  // A client tool: the page itself runs it.
  await say(widget, 'show_product {"product": "storm-shell-jacket"}');
  await expect(page.locator("#storm-shell-jacket")).toHaveClass(/highlight/);

  // A DOM click, not a synthesized pointer click: headless Firefox on Linux delivers no input events at
  // all to the page while the assistant is speaking (not even to a document listener), so a real click
  // there would test Playwright, not the widget.
  await widget.locator('[part="button"]').dispatchEvent("click");
  await expect(widget.locator('[part="button"]')).toHaveAttribute("aria-pressed", "false");
  expect(errors).toEqual([]);
});

test("a script tag with data-relay mounts the widget by itself", async ({ page }) => {
  const shopPage = await (await page.request.get("/")).text();
  const relay = /<script src="([^"]+)\/sdk\/voice-agent\.iife\.js">/.exec(shopPage)?.[1];
  expect(relay).toBeTruthy();
  // A document the shop's own server sent (a 404 page), rewritten in place: the page keeps the shop's
  // origin and address space, so the relay's origin rules and the shop's token route apply as on a real
  // page. (A route-fulfilled page would not do: Chromium treats it as public and blocks the loopback relay.)
  await page.goto("/no-such-page");
  await page.setContent(`<!doctype html><html lang="en"><body><h1>Shop</h1>
    <script src="${relay}/sdk/voice-agent.iife.js" data-relay="${relay}"
      data-token-url="/api/voice-token" data-language="en" data-text-input></script></body></html>`);
  await expect(page.locator("voice-agent")).toHaveCount(1);
  const widget = await startConversation(page);
  await say(widget, 'check stock {"product": "Trail Runner 2"}');
  await expect(widget.locator('[part="lines"]')).toContainText('"inStock":14');
});
