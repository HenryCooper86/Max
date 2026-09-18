import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export type BondedPhone = { path: string; name: string; connected: boolean; trusted: boolean; blocked: boolean };
type Bus = (args: string[]) => Promise<string>;
const devicePath = /^\/org\/bluez\/hci\d+\/dev_(?:[A-Fa-f0-9]{2}_){5}[A-Fa-f0-9]{2}$/;
export function createBluetoothBond(
  bus: Bus,
  changed: () => void,
  now = Date.now,
  file = process.platform === "linux" ? "/var/lib/max/hud-bluetooth-bond.json" : ""
) {
  let path = "",
    enabled = true,
    connecting = false,
    closed = false;
  let nextAttempt = 0,
    retry = 3000;
  let phones: BondedPhone[] = [];
  try {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    if (typeof saved.path === "string" && devicePath.test(saved.path)) {
      path = saved.path;
      enabled = saved.enabled === true;
    } else enabled = false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && file) enabled = false;
  }
  function save() {
    if (!file) return;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file + ".tmp", JSON.stringify({ path, enabled }) + "\n", { mode: 0o600 });
    renameSync(file + ".tmp", file);
  }
  async function connect() {
    if (closed || connecting || !enabled || !path) return;
    connecting = true;
    changed();
    nextAttempt = now() + retry;
    retry = Math.min(60000, retry * 2);
    try {
      for (const uuid of ["0000110a-0000-1000-8000-00805f9b34fb", "0000110c-0000-1000-8000-00805f9b34fb"]) {
        if (closed || !enabled) break;
        try {
          await bus(["call", "org.bluez", path, "org.bluez.Device1", "ConnectProfile", "s", uuid]);
        } catch {
          /* An already-connected audio profile must not prevent player-profile repair. */
        }
      }
    } finally {
      connecting = false;
      if (!closed) changed();
    }
  }
  return {
    observe(values: BondedPhone[], hasPlayer = true) {
      if (closed) return;
      phones = values.filter((p) => devicePath.test(p.path));
      // Adopt only one unambiguous, already paired and trusted phone.
      if (!path && enabled && phones.filter((p) => p.trusted && !p.blocked).length === 1) {
        path = phones.find((p) => p.trusted && !p.blocked)!.path;
        try {
          save();
        } catch {
          enabled = false;
        }
      }
      const phone = phones.find((p) => p.path === path);
      if (phone?.connected && hasPlayer) {
        retry = 3000;
        return;
      }
      if (phone?.trusted && !phone.blocked && enabled && now() >= nextAttempt) void connect();
    },
    get current() {
      const phone = phones.find((p) => p.path === path);
      return { bonded: !!phone, name: phone?.name ?? "", autoReconnect: enabled, connecting };
    },
    async control(action: string) {
      if (!path || !phones.some((p) => p.path === path)) return { ok: false, message: "请先在手机蓝牙中配对 RDK" };
      if (action !== "connect" && action !== "disconnect") return { ok: false, message: "无效的连接操作" };
      enabled = action === "connect";
      try {
        save();
      } catch {
        enabled = false;
        return { ok: false, message: "无法保存连接设置，请重试" };
      }
      if (enabled) {
        nextAttempt = 0;
        retry = 3000;
        void connect();
      } else {
        // Disconnect also cancels any BlueZ Connect already in progress.
        try {
          await bus(["call", "org.bluez", path, "org.bluez.Device1", "Disconnect"]);
        } catch {
          /* Already disconnected: the persisted pause is still effective. */
        }
      }
      changed();
      return { ok: true, message: "" };
    },
    close() {
      closed = true;
    }
  };
}
