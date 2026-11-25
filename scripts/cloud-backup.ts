/**
 * Writes a consistent copy of the Max Cloud database (customers, projects,
 * the ledger, top-up orders and kept conversations) to one file:
 *
 *   npm run cloud:backup -- /backups/max-cloud-2026-11-25.sqlite
 *
 * Run it on the relay host, in the app directory, where the relay's data
 * lives (the same STUDIO_DIR, default ~/.max-relay). The relay can keep
 * running: the copy is taken with SQLite's VACUUM INTO, so it is one moment's
 * state, where copying the files of a live database can catch a write half
 * done and miss the newest top-ups. The target must not exist (an existing
 * backup is never overwritten) and its folder must. The copy holds what the
 * database holds, so keep it as private as CLOUD_SECRET_KEY, and keep the key
 * from the same time with it: the saved model keys need it to be read.
 * Restoring is described in docs/cloud.md (Backup and restore).
 */
// The relay reads its settings from .env in the app directory, and so does this script; exported variables win.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { backupDatabase, cloudDatabasePath } from "../server/cloud/store";

const [target] = process.argv.slice(2);
if (!target || target.startsWith("-")) {
  console.error("Usage: npm run cloud:backup -- <target file>");
  process.exit(1);
}
const source = cloudDatabasePath();
if (source === ":memory:" || !fs.existsSync(source)) {
  console.error(`There is no Max Cloud database at ${source}. Run this where the relay keeps its data.`);
  process.exit(1);
}
try {
  const file = backupDatabase(path.resolve(target));
  const size = (fs.statSync(file).size / 1024).toFixed(0);
  console.log(`Copied ${source} to ${file} (${size} KB). The relay kept running; the copy is one moment's state.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
