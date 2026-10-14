import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { useHelmetAgent } from "../src/hooks/useHelmetAgent";
import { buildHealth } from "../server/config";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let renderer: ReactTestRenderer | undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("publishes a slow healthy response rather than superseding it on every poll", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", {
    location: { search: "" },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  });
  vi.stubGlobal("document", { hidden: false, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal("navigator", { language: "en-US" });
  const health = buildHealth(1, false);
  const requests: Array<(response: Response) => void> = [];
  vi.stubGlobal(
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        requests.push(resolve);
      })
  );
  let agent!: ReturnType<typeof useHelmetAgent>;
  function Harness() {
    agent = useHelmetAgent();
    return null;
  }
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  await act(async () => {
    requests[0]!(new Response(JSON.stringify(health)));
  });

  expect(agent.health?.provider).toBe(health.provider);
  expect(requests).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(requests).toHaveLength(2);
  await act(async () => {
    requests[1]!(new Response(JSON.stringify(health)));
  });
});
