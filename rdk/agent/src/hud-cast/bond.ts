import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** A single remembered phone. Only a digest is kept on the receiver. */
export function createHudBond(file = process.platform === "linux" ? "/var/lib/max/hud-wifi-bond.json" : "") {
  let digest = "";
  try {
    const stored = JSON.parse(readFileSync(file, "utf8"));
    if (typeof stored.digest === "string" && /^[a-f0-9]{64}$/.test(stored.digest)) digest = stored.digest;
  } catch {
    /* No valid bond: a displayed code is required. */
  }
  return {
    accepts(token: unknown) {
      if (!digest || typeof token !== "string" || !/^[\w-]{43}$/.test(token)) return false;
      return timingSafeEqual(Buffer.from(digest, "hex"), createHash("sha256").update(token).digest());
    },
    issue() {
      const token = randomBytes(32).toString("base64url");
      const next = createHash("sha256").update(token).digest("hex");
      if (file) {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file + ".tmp", JSON.stringify({ digest: next }) + "\n", { mode: 0o600 });
        renameSync(file + ".tmp", file);
      }
      digest = next;
      return token;
    }
  };
}
