/** One browser-owned queue shared by voice, buttons and track completion. */
export type MusicControl = "play" | "pause" | "next" | "previous";
export type MusicTrack = { title: string; url: string };
export type MusicState = {
  visible: boolean;
  tracks: MusicTrack[];
  index: number;
  playing: boolean;
  busy: boolean;
  message: string | null;
};
export type MusicResult = { status: "ok" | "failed" | "unsupported"; reason?: string };
export const EMPTY_MUSIC: MusicState = {
  visible: false,
  tracks: [],
  index: -1,
  playing: false,
  busy: false,
  message: null
};
type AudioDriver = Pick<
  HTMLAudioElement,
  "src" | "paused" | "play" | "pause" | "load" | "addEventListener" | "removeAttribute"
>;

export function createMusicController(deps: {
  createAudio: () => AudioDriver;
  onState: (state: MusicState) => void;
  revokeUrl: (url: string) => void;
}) {
  let state: MusicState = { ...EMPTY_MUSIC };
  let audio: AudioDriver | null = null;
  let generation = 0;
  let cancelPlay: (() => void) | undefined;
  const publish = (patch: Partial<MusicState>) => {
    state = { ...state, ...patch };
    deps.onState(state);
  };
  const fail = (reason: string, message: string): MusicResult => {
    publish({ message });
    return { status: "failed", reason };
  };
  function driver() {
    if (!audio) {
      audio = deps.createAudio();
      audio.addEventListener("play", () => publish({ playing: true }));
      audio.addEventListener("pause", () => publish({ playing: false }));
      audio.addEventListener("ended", () => {
        publish({ playing: false });
        if (state.index + 1 < state.tracks.length) void perform("next");
      });
      audio.addEventListener("error", () => {
        cancelPlay?.();
        publish({ playing: false, busy: false, message: "无法播放此文件，请选择浏览器支持的音频。" });
      });
    }
    return audio;
  }
  function stop() {
    generation += 1;
    cancelPlay?.();
    audio?.pause();
    publish({ playing: false, busy: false });
  }
  async function perform(control: MusicControl, app?: string): Promise<MusicResult> {
    if (app) return { status: "unsupported", reason: "player.unsupported" };
    if (control === "pause") {
      stop();
      return { status: "ok" };
    }
    publish({ visible: true });
    if (state.busy) return { status: "failed", reason: "music.busy" };
    if (!state.tracks.length) return fail("music.emptyQueue", "请先选择多首音乐文件，歌曲只在此浏览器播放。");
    const index = state.index + (control === "next" ? 1 : control === "previous" ? -1 : 0);
    if (index < 0 || index >= state.tracks.length) return fail("music.queueEnd", "已到播放队列边界，请选择更多音乐。");
    const owner = ++generation;
    const player = driver();
    const track = state.tracks[index]!;
    if (player.src !== track.url) player.src = track.url;
    publish({ index, busy: true, message: null });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        player.play(),
        new Promise<never>((_, reject) => {
          cancelPlay = () => reject(new Error("cancelled"));
          timer = setTimeout(() => reject(new Error("timeout")), 6000);
        })
      ]);
      if (owner !== generation) return { status: "failed", reason: "action.cancelled" };
      if (player.paused) throw new Error("paused");
      publish({ playing: true });
      return { status: "ok" };
    } catch {
      if (owner !== generation) return { status: "failed", reason: "action.cancelled" };
      player.pause();
      return fail("music.unavailable", "播放未开始，请点播放按钮授权音频，或重新选择可用的音乐文件。");
    } finally {
      clearTimeout(timer);
      if (owner === generation) {
        cancelPlay = undefined;
        publish({ busy: false });
      }
    }
  }
  function clear() {
    stop();
    if (audio) {
      audio.removeAttribute("src");
      audio.load();
    }
    state.tracks.forEach((track) => deps.revokeUrl(track.url));
    publish({ ...EMPTY_MUSIC });
  }
  function select(tracks: MusicTrack[]) {
    clear();
    if (!tracks.length) return;
    publish({ tracks, index: 0, visible: true });
    void perform("play");
  }
  return { perform, select, stop, clear };
}
