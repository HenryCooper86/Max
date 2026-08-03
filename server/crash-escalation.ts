import type { ClientEvent, CrashAckStatus } from "../shared/agent";
import { appendTestingAudit } from "./testing-store";

export type CrashAlertEvent = Extract<ClientEvent, { type: "crash.alert" }>;
export type CrashCancelEvent = Extract<ClientEvent, { type: "crash.cancel" }>;

export type CrashNotifyOutcome = { status: CrashAckStatus; detail?: string };

/** A delivery channel for crash escalation. The log notifier is the honest
 *  default: it records the incident but texts nobody, so its outcome is
 *  "unconfigured" — Max must tell the rider to dial by hand. */
export type CrashNotifier = {
  name: string;
  notify(alert: CrashAlertEvent): Promise<CrashNotifyOutcome>;
  followUp(cancel: CrashCancelEvent): Promise<void>;
};

export function crashSmsBody(alert: CrashAlertEvent): string {
  const formatCoord = (n: number) => parseFloat(n.toFixed(5)).toString();
  const location =
    typeof alert.lat === "number" && typeof alert.lon === "number"
      ? `位置：${formatCoord(alert.lat)},${formatCoord(alert.lon)} https://uri.amap.com/marker?position=${formatCoord(alert.lon)},${formatCoord(alert.lat)}`
      : "位置未知";
  const when = alert.detectedAt
    ? new Date(alert.detectedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
    : "";
  return `【Max头盔】检测到骑手疑似摔车，且未响应确认。${location}。${when ? `时间：${when}。` : ""}请尽快联系骑手或报警。`;
}

export function crashCancelSmsBody(): string {
  return "【Max头盔】刚才的事故警报是误报，骑手已确认没事。";
}

export function createLogNotifier(): CrashNotifier {
  return {
    name: "log",
    async notify() {
      return { status: "unconfigured", detail: "未配置短信通道" };
    },
    async followUp() {
      /* nothing to send; the incident audit already records the cancel */
    }
  };
}

export function selectCrashNotifier(name: string): CrashNotifier {
  if (name !== "log") {
    console.warn(`[crash] 未知的通知通道 "${name}"，退回仅记录模式`);
  }
  return createLogNotifier();
}

export async function handleCrashAlert(
  alert: CrashAlertEvent,
  notifier: CrashNotifier,
  send: (payload: unknown) => void,
  audit: typeof appendTestingAudit = appendTestingAudit
): Promise<void> {
  audit("relay", "crash.alert", "session", alert.incidentId, {
    lat: alert.lat,
    lon: alert.lon,
    speedKmhRecent: alert.speedKmhRecent,
    contactOptIn: alert.contactOptIn,
    notifier: notifier.name
  });

  let outcome: CrashNotifyOutcome;
  if (!alert.contactOptIn || !alert.contactNumber) {
    outcome = { status: "unconfigured", detail: "未开启紧急联系人通知" };
  } else {
    try {
      outcome = await notifier.notify(alert);
    } catch (error) {
      outcome = { status: "failed", detail: error instanceof Error ? error.message : "notify failed" };
    }
  }

  send({
    type: "crash.ack",
    incidentId: alert.incidentId,
    status: outcome.status,
    ...(outcome.detail ? { detail: outcome.detail } : {})
  });
}

export async function handleCrashCancel(
  cancel: CrashCancelEvent,
  notifier: CrashNotifier,
  audit: typeof appendTestingAudit = appendTestingAudit
): Promise<void> {
  audit("relay", "crash.cancel", "session", cancel.incidentId, { notifier: notifier.name });
  try {
    await notifier.followUp(cancel);
  } catch {
    /* follow-up is best-effort; the audit row is the durable record */
  }
}
