import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const exec = promisify(execFile);
const actions = { play: "Play", pause: "Pause", next: "Next", previous: "Previous" } as const;
export type MusicAction = keyof typeof actions;
type Player = {
  path: string;
  name: string;
  title: string;
  artist: string;
  album: string;
  status: string;
  position: number | null;
  duration: number | null;
};
export type HudMusic = {
  available: boolean;
  connected: boolean;
  busy: boolean;
  player: (Omit<Player, "path"> & { id: string }) | null;
  message: string;
};
type Bus = (args: string[]) => Promise<string>;
const systemBus: Bus = async (args) =>
  (await exec("busctl", ["--system", "--json=short", "--timeout=2", ...args], { timeout: 2500, maxBuffer: 512 * 1024 }))
    .stdout;
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const value = (v: unknown) => record(v).data;
const text = (v: unknown) => (typeof v === "string" ? v.slice(0, 200) : "");
const milliseconds = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 0xffffffff ? v : null;
const playerPath = /^\/org\/bluez\/hci\d+\/dev_[A-Fa-f0-9_]+\/player\d+$/;

/** Decode busctl's typed variants; only connected, paired phone players are eligible. */
export function readBluetoothPlayers(json: string) {
  const data = record(JSON.parse(json)).data;
  const objects = record(Array.isArray(data) ? data[0] : null);
  let connected = false;
  const players: Player[] = [];
  for (const interfaces of Object.values(objects)) {
    const device = record(record(interfaces)["org.bluez.Device1"]);
    if (value(device.Connected) === true && value(device.Paired) === true) connected = true;
  }
  for (const [path, interfaces] of Object.entries(objects)) {
    if (!playerPath.test(path)) continue;
    const player = record(record(interfaces)["org.bluez.MediaPlayer1"]);
    const devicePath = text(value(player.Device));
    if (!path.startsWith(devicePath + "/") || !devicePath) continue;
    const device = record(record(objects[devicePath])["org.bluez.Device1"]);
    if (value(device.Connected) !== true || value(device.Paired) !== true) continue;
    const control = record(record(objects[devicePath])["org.bluez.MediaControl1"]);
    const addressed = value(control.Player);
    if (typeof addressed === "string" && addressed !== path) continue;
    const track = record(value(player.Track));
    players.push({
      path,
      name: text(value(player.Name)) || "手机音乐",
      title: text(value(track.Title)),
      artist: text(value(track.Artist)),
      album: text(value(track.Album)),
      status: text(value(player.Status)),
      position: milliseconds(value(player.Position)),
      duration: milliseconds(value(track.Duration))
    });
  }
  return { connected, players };
}

/** Reads the phone's AVRCP session independently of navigation; never starts playback automatically. */
export function createHudMusic(
  changed: () => void,
  bus: Bus = systemBus,
  enabled = process.platform === "linux",
  now = Date.now
) {
  let state: HudMusic = {
    available: enabled,
    connected: false,
    busy: false,
    player: null,
    message: "在手机蓝牙中连接 RDK，然后播放音乐"
  };
  let selected: Player | null = null;
  let id = "";
  let fetchedAt = 0;
  let closed = false;
  let reading: Promise<void> | undefined;
  function publish() {
    if (!closed) changed();
  }
  function clear(message: string) {
    selected = null;
    id = "";
    state = { ...state, player: null, message };
  }
  async function read() {
    try {
      const snapshot = readBluetoothPlayers(
        await bus(["call", "org.bluez", "/", "org.freedesktop.DBus.ObjectManager", "GetManagedObjects"])
      );
      if (closed) return;
      state.connected = snapshot.connected;
      const playing = snapshot.players.filter((p) => p.status === "playing");
      const candidates = playing.length ? playing : snapshot.players;
      const player = candidates.length === 1 ? candidates[0]! : null;
      fetchedAt = now();
      if (!player)
        clear(
          candidates.length > 1
            ? "多个音乐播放器已连接，请在手机选择一个播放"
            : snapshot.connected
              ? "蓝牙已连接 · 请在手机播放音乐"
              : "在手机蓝牙中连接 RDK，然后播放音乐"
        );
      else {
        if (selected?.path !== player.path || selected?.name !== player.name) id = randomUUID();
        selected = player;
        state.player = {
          id,
          name: player.name,
          title: player.title,
          artist: player.artist,
          album: player.album,
          status: player.status,
          position: player.position,
          duration: player.duration
        };
        state.message = "";
      }
    } catch {
      if (closed) return;
      state.connected = false;
      clear("蓝牙音乐暂不可用 · 请检查手机连接");
    }
    publish();
  }
  function update() {
    if (closed || !enabled) return Promise.resolve();
    if (!reading)
      reading = read().finally(() => {
        reading = undefined;
      });
    return reading;
  }
  const timer = enabled
    ? setInterval(() => {
        void update();
      }, 1000)
    : undefined;
  timer?.unref();
  return {
    update,
    get current(): HudMusic {
      if (state.player && now() - fetchedAt > 5000)
        return { ...state, player: null, message: "正在重新连接音乐播放器" };
      return { ...state, player: state.player ? { ...state.player } : null };
    },
    async control(action: unknown, expectedId: unknown): Promise<{ ok: boolean; message: string }> {
      if (typeof action !== "string" || !Object.hasOwn(actions, action) || typeof expectedId !== "string")
        return { ok: false, message: "无效的音乐操作" };
      if (closed || state.busy) return { ok: false, message: "请等待当前操作完成" };
      state.busy = true;
      publish();
      try {
        await update();
        const before = selected;
        if (!before || id !== expectedId || now() - fetchedAt > 5000 || closed)
          return { ok: false, message: "播放器已改变，请重试" };
        await bus(["call", "org.bluez", before.path, "org.bluez.MediaPlayer1", actions[action as MusicAction]]);
        // The UI follows reported state, not an optimistic click result.
        for (let attempt = 0; attempt < 4 && !closed; attempt++) {
          await update();
          const after = selected as Player | null;
          if (id !== expectedId || !after) return { ok: false, message: "音乐连接已改变" };
          const changedTrack =
            after.title !== before.title ||
            after.artist !== before.artist ||
            after.album !== before.album ||
            (after.position !== null && before.position !== null && before.position - after.position > 1500);
          if (
            action === "play"
              ? after.status === "playing"
              : action === "pause"
                ? after.status === "paused" || after.status === "stopped"
                : changedTrack
          )
            return { ok: true, message: "" };
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return { ok: false, message: "手机未确认操作，请检查音乐队列" };
      } catch {
        return { ok: false, message: "当前音乐应用不支持此操作或连接已断开" };
      } finally {
        state.busy = false;
        publish();
      }
    },
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      clear("");
    }
  };
}
