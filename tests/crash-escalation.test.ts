import { describe, expect, it, vi } from "vitest";
import {
  createLogNotifier,
  crashCancelSmsBody,
  crashSmsBody,
  handleCrashAlert,
  handleCrashCancel,
  selectCrashNotifier,
  type CrashAlertEvent,
  type CrashNotifier
} from "../server/crash-escalation";

const alert = (overrides: Partial<CrashAlertEvent> = {}): CrashAlertEvent => ({
  type: "crash.alert",
  incidentId: "i1",
  contactOptIn: true,
  contactNumber: "+8613800000000",
  lat: 31.23,
  lon: 121.47,
  speedKmhRecent: 42,
  detectedAt: 1754200000000,
  ...overrides
});

describe("crashSmsBody", () => {
  it("names the incident, the location, and an amap link", () => {
    const body = crashSmsBody(alert());
    expect(body).toContain("Max");
    expect(body).toContain("31.23");
    expect(body).toContain("https://uri.amap.com/marker?position=121.47,31.23");
  });

  it("omits the location line when there is no fix", () => {
    const body = crashSmsBody(alert({ lat: undefined, lon: undefined }));
    expect(body).not.toContain("amap");
    expect(body).toContain("位置未知");
  });

  it("has a false-alarm follow-up", () => {
    expect(crashCancelSmsBody()).toContain("误报");
  });
});

describe("notifier selection", () => {
  it("defaults to the log notifier and falls back on unknown names", () => {
    expect(createLogNotifier().name).toBe("log");
    expect(selectCrashNotifier("log").name).toBe("log");
    expect(selectCrashNotifier("aliyun-sms").name).toBe("log");
  });
});

describe("handleCrashAlert", () => {
  it("acks unconfigured when only the log notifier exists", async () => {
    const send = vi.fn();
    const audit = vi.fn();
    await handleCrashAlert(alert(), createLogNotifier(), send, audit as never);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "crash.ack", incidentId: "i1", status: "unconfigured" })
    );
    expect(audit).toHaveBeenCalledWith("relay", "crash.alert", "session", "i1", expect.any(Object));
  });

  it("acks unconfigured without calling notify when the rider did not opt in", async () => {
    const send = vi.fn();
    const notify = vi.fn();
    const notifier: CrashNotifier = { name: "spy", notify, followUp: vi.fn() };
    await handleCrashAlert(alert({ contactOptIn: false, contactNumber: undefined }), notifier, send, vi.fn() as never);
    expect(notify).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ status: "unconfigured" }));
  });

  it("acks failed when the notifier throws", async () => {
    const send = vi.fn();
    const notifier: CrashNotifier = {
      name: "boom",
      notify: vi.fn().mockRejectedValue(new Error("sms down")),
      followUp: vi.fn()
    };
    await handleCrashAlert(alert(), notifier, send, vi.fn() as never);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "crash.ack", status: "failed" }));
  });
});

describe("handleCrashCancel", () => {
  it("audits and forwards the follow-up", async () => {
    const followUp = vi.fn().mockResolvedValue(undefined);
    const audit = vi.fn();
    await handleCrashCancel(
      { type: "crash.cancel", incidentId: "i1" },
      { name: "spy", notify: vi.fn(), followUp },
      audit as never
    );
    expect(followUp).toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith("relay", "crash.cancel", "session", "i1", expect.any(Object));
  });
});
