import { renameSync, writeFileSync } from "node:fs";
import { loadOrCreateDeviceId } from "../../rdk/agent/src/device/identity";

const path = process.env.IDENTITY_PATH;
const id = process.env.IDENTITY_ID;
if (!path || !id) throw new Error("IDENTITY_PATH and IDENTITY_ID are required");

const result = loadOrCreateDeviceId({
  path,
  randomId: () => id,
  writeFile: (file, data, options) => {
    writeFileSync(file, data, options);
    if (process.env.IDENTITY_HOLD_MS && file.toString().includes(".tmp-")) {
      process.send?.({ type: "temp-written" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.IDENTITY_HOLD_MS));
    }
  },
  rename: (from, to) => {
    renameSync(from, to);
    if (process.env.IDENTITY_CRASH_AFTER_RENAME === "1") process.kill(process.pid, "SIGKILL");
  }
});
process.stdout.write(result);
