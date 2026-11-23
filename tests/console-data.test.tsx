import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { createCloudApi, type Me } from "../src/console/api";
import { useConsoleData, type Session } from "../src/console/hooks";

let renderer: ReactTestRenderer | undefined;
let data: ReturnType<typeof useConsoleData>;

async function mount(api: Session["api"], fail = vi.fn(String)) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  function Dashboard() {
    data = useConsoleData({ api, token: "t", fail });
    return null;
  }
  await act(async () => {
    renderer = create(<Dashboard />);
  });
}

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const api = createCloudApi(async () => new Response("{}"));
const me: Me = {
  customer: { id: "id", email: "demo@example.com", createdAt: 0 },
  balance: { fen: 100, freeSecondsLeft: 60, month: "2026-11" }
};

it("keeps a project load error visible when the balance loads afterward", async () => {
  const balance = Promise.withResolvers<Me>();
  await mount({ ...api, listProjects: vi.fn().mockRejectedValue("project load failed"), me: () => balance.promise });
  expect(data.projectsError).toContain("project load failed");
  await act(async () => balance.resolve(me));
  expect(data.me).toEqual(me);
  expect(data.projectsError).toContain("project load failed");
});

it("keeps a refreshed balance when the original request finishes last", async () => {
  const older = Promise.withResolvers<Me>();
  const updated = { ...me, balance: { ...me.balance, fen: 200 } };
  await mount({ ...api, me: vi.fn().mockReturnValueOnce(older.promise).mockResolvedValue(updated) });
  await act(async () => {
    data.refreshMoney();
  });
  expect(data.me).toEqual(updated);
  await act(async () => older.resolve(me));
  expect(data.me).toEqual(updated);
});

it("ignores a rejected project request after signing out", async () => {
  const request = Promise.withResolvers<Awaited<ReturnType<typeof api.listProjects>>>();
  const fail = vi.fn(String);
  await mount({ ...api, listProjects: () => request.promise }, fail);
  await act(async () => renderer?.unmount());
  renderer = undefined;
  await act(async () => request.reject(new Error("expired session")));
  expect(fail).not.toHaveBeenCalled();
});
