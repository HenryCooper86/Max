import { afterEach, describe, expect, it, vi } from "vitest";
import { createHudMusic, readBluetoothPlayers } from "../rdk/agent/src/hud-cast/music";

const device = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF";
const path = device + "/player0";
const variant = (data: unknown) => ({ data });
function snapshot(
  options: {
    connected?: boolean;
    paired?: boolean;
    name?: string;
    title?: string;
    status?: string;
    position?: number;
  } = {}
) {
  return JSON.stringify({
    data: [
      {
        [device]: {
          "org.bluez.Device1": {
            Connected: variant(options.connected ?? true),
            Paired: variant(options.paired ?? true)
          },
          "org.bluez.MediaControl1": { Player: variant(path) }
        },
        [path]: {
          "org.bluez.MediaPlayer1": {
            Device: variant(device),
            Name: variant(options.name ?? "Max"),
            Status: variant(options.status ?? "playing"),
            Position: variant(options.position ?? 3000),
            Track: variant({
              Title: variant(options.title ?? "Track One"),
              Artist: variant("Artist"),
              Duration: variant(180000)
            })
          }
        }
      }
    ]
  });
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
});
function harness() {
  let json = snapshot();
  let time = 1000;
  let fail = false;
  const bus = vi.fn(async (args: string[]) => {
    if (fail) throw new Error("unavailable");
    if (args.at(-1) === "Pause") json = snapshot({ status: "paused" });
    if (args.at(-1) === "Play") json = snapshot({ status: "playing" });
    if (args.at(-1) === "Next") json = snapshot({ title: "Track Two", position: 0 });
    return json;
  });
  const music = createHudMusic(vi.fn(), bus, true, () => time);
  cleanups.push(music.close);
  return {
    music,
    bus,
    set: (value: string) => {
      json = value;
    },
    fail: () => {
      fail = true;
    },
    advance: () => {
      time += 6000;
    }
  };
}
describe("Bluetooth HUD music", () => {
  it("accepts only paired connected players and decodes reported metadata", () => {
    expect(readBluetoothPlayers(snapshot()).players[0]).toMatchObject({
      title: "Track One",
      artist: "Artist",
      duration: 180000,
      status: "playing"
    });
    expect(readBluetoothPlayers(snapshot({ connected: false })).players).toEqual([]);
    expect(readBluetoothPlayers(snapshot({ paired: false })).players).toEqual([]);
  });
  it("controls the current phone player and confirms pause, resume and skip from reported state", async () => {
    const h = harness();
    await h.music.update();
    const id = h.music.current.player!.id;
    expect(await h.music.control("pause", id)).toEqual({ ok: true, message: "" });
    expect(h.music.current.player?.status).toBe("paused");
    expect(await h.music.control("play", id)).toEqual({ ok: true, message: "" });
    expect(await h.music.control("next", id)).toEqual({ ok: true, message: "" });
    expect(h.music.current.player?.title).toBe("Track Two");
    expect(h.bus).toHaveBeenCalledWith(["call", "org.bluez", path, "org.bluez.MediaPlayer1", "Next"]);
  });
  it("confirms Play when iOS publishes its active app name after waking the same player", async () => {
    let json = snapshot({ name: "Music", status: "stopped" });
    const bus = vi.fn(async (args: string[]) => {
      if (args.at(-1) === "Play") json = snapshot({ name: "QQMusic", status: "playing" });
      return json;
    });
    const music = createHudMusic(() => {}, bus, true);
    cleanups.push(music.close);
    await music.update();
    expect((await music.control("play", music.current.player!.id)).ok).toBe(true);
    expect(music.current.player?.name).toBe("QQMusic");
  });
  it("rejects stale controls after the phone changes app or reconnects", async () => {
    const h = harness();
    await h.music.update();
    const id = h.music.current.player!.id;
    h.set(snapshot({ name: "Other App" }));
    expect((await h.music.control("pause", id)).ok).toBe(false);
    expect(h.bus.mock.calls.some(([args]) => args.at(-1) === "Pause")).toBe(false);
    const nextId = h.music.current.player!.id;
    h.set(snapshot({ connected: false }));
    await h.music.update();
    expect(h.music.current.player).toBeNull();
    h.set(snapshot({ name: "Other App" }));
    await h.music.update();
    expect(h.music.current.player!.id).not.toBe(nextId);
  });
  it("hides stale metadata and clears controls on bus errors", async () => {
    const h = harness();
    await h.music.update();
    h.advance();
    expect(h.music.current.player).toBeNull();
    h.fail();
    await h.music.update();
    expect(h.music.current).toMatchObject({ connected: false, player: null });
  });
  it("does not issue arbitrary actions or commands after close", async () => {
    const h = harness();
    await h.music.update();
    const id = h.music.current.player!.id;
    expect((await h.music.control("Stop; reboot", id)).ok).toBe(false);
    h.music.close();
    expect((await h.music.control("play", id)).ok).toBe(false);
    expect(h.bus).toHaveBeenCalledTimes(1);
  });
  it("does not claim a successful skip when the phone reports no change", async () => {
    const bus = vi.fn(async () => snapshot());
    const music = createHudMusic(() => {}, bus, true);
    cleanups.push(music.close);
    await music.update();
    expect((await music.control("next", music.current.player!.id)).ok).toBe(false);
  });
  it("discards a read completing after service shutdown", async () => {
    let finish!: (json: string) => void;
    const changed = vi.fn();
    const music = createHudMusic(
      changed,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      true
    );
    const pending = music.update();
    music.close();
    finish(snapshot());
    await pending;
    expect(music.current.player).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });
});
