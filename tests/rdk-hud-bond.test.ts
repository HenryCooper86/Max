import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHudBond } from "../rdk/agent/src/hud-cast/bond";
import { createBluetoothBond } from "../rdk/agent/src/hud-cast/bluetooth-bond";
const phone = {
  path: "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF",
  name: "Phone",
  connected: false,
  trusted: true,
  blocked: false
};
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
describe("remembered HUD pairing", () => {
  it("persists only a credential digest and invalidates the previous pairing on replacement", () => {
    const dir = mkdtempSync(join(tmpdir(), "hud-bond-"));
    try {
      const file = join(dir, "wifi.json"),
        bond = createHudBond(file);
      const token = bond.issue();
      expect(readFileSync(file, "utf8")).not.toContain(token);
      const restored = createHudBond(file);
      expect(restored.accepts(token)).toBe(true);
      expect(restored.accepts("invalid")).toBe(false);
      expect(restored.accepts(token.slice(1))).toBe(false);
      const replacement = restored.issue();
      expect(restored.accepts(token)).toBe(false);
      expect(createHudBond(file).accepts(replacement)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("reconnects a trusted phone using the audio-source and remote-player profiles, with backoff", async () => {
    let time = 1000;
    const bus = vi.fn(async () => "");
    const bond = createBluetoothBond(
      bus,
      () => {},
      () => time,
      ""
    );
    bond.observe([phone]);
    await settle();
    expect(bus.mock.calls).toHaveLength(2);
    expect(bus.mock.calls[0]).toEqual([
      [
        "call",
        "org.bluez",
        phone.path,
        "org.bluez.Device1",
        "ConnectProfile",
        "s",
        "0000110a-0000-1000-8000-00805f9b34fb"
      ]
    ]);
    bond.observe([phone]);
    expect(bus).toHaveBeenCalledTimes(2);
    time += 4000;
    bond.observe([phone]);
    await settle();
    expect(bus).toHaveBeenCalledTimes(4);
    bond.observe([{ ...phone, connected: true }]);
    await settle();
    expect(bus).toHaveBeenCalledTimes(4);
    bond.close();
  });
  it("persists deliberate disconnect across restart and resumes only after explicit connect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hud-bt-"));
    try {
      const file = join(dir, "bt.json");
      const bus = vi.fn(async () => "");
      const bond = createBluetoothBond(bus, () => {}, Date.now, file);
      bond.observe([{ ...phone, connected: true }]);
      expect((await bond.control("disconnect")).ok).toBe(true);
      bond.close();
      bus.mockClear();
      const restored = createBluetoothBond(bus, () => {}, Date.now, file);
      restored.observe([phone]);
      await settle();
      expect(restored.current.autoReconnect).toBe(false);
      expect(bus).not.toHaveBeenCalled();
      await restored.control("connect");
      await settle();
      expect(restored.current.autoReconnect).toBe(true);
      expect(bus).toHaveBeenCalledTimes(2);
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("still repairs the player profile when audio reports already connected", async () => {
    const bus = vi.fn(async (args: string[]) => {
      if (args.at(-1)?.startsWith("0000110a")) throw new Error("AlreadyConnected");
      return "";
    });
    const bond = createBluetoothBond(bus, () => {}, Date.now, "");
    bond.observe([{ ...phone, connected: true }], false);
    await settle();
    expect(bus).toHaveBeenCalledTimes(2);
    bond.close();
  });
  it("does not auto-connect untrusted, blocked or ambiguous phones", async () => {
    for (const phones of [
      [{ ...phone, trusted: false }],
      [{ ...phone, blocked: true }],
      [phone, { ...phone, path: phone.path.replace("FF", "00") }]
    ]) {
      const bus = vi.fn(async () => "");
      const bond = createBluetoothBond(bus, () => {}, Date.now, "");
      bond.observe(phones);
      await settle();
      expect(bus).not.toHaveBeenCalled();
      bond.close();
    }
  });
  it("repairs a connected phone with missing metadata without restarting Bluetooth", async () => {
    const bus = vi.fn(async () => "");
    const bond = createBluetoothBond(bus, () => {}, Date.now, "");
    bond.observe([{ ...phone, connected: true }], false);
    await settle();
    expect(bus).toHaveBeenCalledTimes(2);
    bond.close();
  });
});
