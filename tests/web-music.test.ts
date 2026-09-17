import { describe, expect, it, vi } from "vitest";
import { createMusicController, EMPTY_MUSIC, type MusicState } from "../src/lib/music";

function fixture() {
  let state: MusicState = EMPTY_MUSIC;
  const handlers = new Map<string, () => void>();
  const audio = {
    src: "",
    paused: true,
    play: vi.fn(async () => {
      audio.paused = false;
      handlers.get("play")?.();
    }),
    pause: vi.fn(() => {
      audio.paused = true;
      handlers.get("pause")?.();
    }),
    load: vi.fn(),
    removeAttribute: vi.fn(() => {
      audio.src = "";
    }),
    addEventListener: vi.fn((event: string, handler: EventListenerOrEventListenerObject) =>
      handlers.set(event, handler as () => void)
    )
  };
  const revokeUrl = vi.fn();
  const player = createMusicController({
    createAudio: () => audio,
    onState: (next) => {
      state = next;
    },
    revokeUrl
  });
  const tracks = [
    { title: "First", url: "blob:first" },
    { title: "Second", url: "blob:second" }
  ];
  return { player, audio, tracks, revokeUrl, state: () => state, ended: () => handlers.get("ended")?.() };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("browser music queue", () => {
  it("stays hidden until music is requested and hides again when closed", async () => {
    const f = fixture();
    expect(f.state().visible).toBe(false);
    await f.player.perform("pause");
    expect(f.state().visible).toBe(false);
    await f.player.perform("play");
    expect(f.state().visible).toBe(true);
    expect(f.state().message).toContain("选择");
    f.player.clear();
    expect(f.state().visible).toBe(false);
    f.player.select(f.tracks);
    await settle();
    expect(f.state().visible).toBe(true);
    f.player.clear();
    expect(f.state().visible).toBe(false);
  });
  it("actually changes the audio source when voice requests next or previous", async () => {
    const f = fixture();
    f.player.select(f.tracks);
    await settle();
    expect(f.audio.src).toBe("blob:first");
    expect(await f.player.perform("next")).toEqual({ status: "ok" });
    expect(f.audio.src).toBe("blob:second");
    expect(f.state().index).toBe(1);
    expect(await f.player.perform("previous")).toEqual({ status: "ok" });
    expect(f.audio.src).toBe("blob:first");
  });
  it("reports an empty queue and boundary rather than claiming a skip", async () => {
    const f = fixture();
    expect((await f.player.perform("next")).reason).toBe("music.emptyQueue");
    f.player.select(f.tracks);
    await settle();
    expect((await f.player.perform("previous")).reason).toBe("music.queueEnd");
    await f.player.perform("next");
    expect((await f.player.perform("next")).reason).toBe("music.queueEnd");
    expect(f.audio.src).toBe("blob:second");
  });
  it("advances automatically and releases old object URLs when replacing the queue", async () => {
    const f = fixture();
    f.player.select(f.tracks);
    await settle();
    f.ended();
    await settle();
    expect(f.audio.src).toBe("blob:second");
    f.player.clear();
    expect(f.revokeUrl.mock.calls).toEqual([["blob:first"], ["blob:second"]]);
    expect(f.audio.paused).toBe(true);
    expect(f.state().tracks).toEqual([]);
  });
  it("does not acknowledge blocked browser playback as success", async () => {
    const f = fixture();
    f.audio.play.mockRejectedValue(new Error("NotAllowedError"));
    f.player.select(f.tracks);
    await settle();
    expect((await f.player.perform("play")).reason).toBe("music.unavailable");
    expect(f.state().playing).toBe(false);
    expect(f.state().busy).toBe(false);
  });
  it("pause cancels a pending play and leaves the queue usable", async () => {
    const f = fixture();
    f.audio.play.mockImplementationOnce(() => new Promise(() => {}));
    f.player.select(f.tracks);
    expect(await f.player.perform("pause")).toEqual({ status: "ok" });
    await settle();
    expect(f.state().busy).toBe(false);
    expect(await f.player.perform("next")).toEqual({ status: "ok" });
  });
  it("rejects third party player requests without changing local playback", async () => {
    const f = fixture();
    expect(await f.player.perform("next", "Spotify")).toEqual({ status: "unsupported", reason: "player.unsupported" });
    expect(f.audio.play).not.toHaveBeenCalled();
  });
});
