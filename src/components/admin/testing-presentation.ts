import type { TesterSessionSummary } from "../../../shared/agent";
import { TESTING_TEST_CASES, type TestingQuality } from "../../../shared/testing";
import { localized, type Language } from "../../lib/i18n";

/**
 * Human-readable presentation for the testing workspace. System enums never
 * leak raw codes or identifiers: unknown values fall back to a meaningful
 * localized generic, while user-authored text (names, notes, feedback) is
 * preserved verbatim.
 */

type TestingResultTone = "good" | "warn" | "alert";

export function testingQualityLabel(quality: TestingQuality | "all", language: Language = "zh-CN"): string {
  if (quality === "all") return localized(language, "全部", "All");
  if (quality === "pass") return localized(language, "通过", "Passed");
  if (quality === "watch") return localized(language, "需关注", "Needs attention");
  return localized(language, "未通过", "Failed");
}

const PLATFORM_LABELS: Record<string, [string, string]> = {
  web: ["网页浏览器", "Web browser"],
  ios: ["iPhone", "iPhone"],
  android: ["安卓手机", "Android phone"],
  embedded: ["智能头盔", "Helmet"],
  unknown: ["未知设备", "Unknown device"]
};

export function testingPlatformLabel(platform: string, language: Language = "zh-CN"): string {
  const label = PLATFORM_LABELS[platform];
  return label ? localized(language, label[0], label[1]) : localized(language, "其他设备", "Other device");
}

const CATALOG_NAMES: Record<string, string> = {};
for (const testCase of TESTING_TEST_CASES) CATALOG_NAMES[testCase.id] = testCase.name;

const TEST_CASE_TITLES: Record<string, [string, string]> = {
  "baseline-live-session": ["日常对话", "Everyday conversation"],
  "wake-word-addressed-only": ["只在呼叫时回应", "Respond only when called"],
  "emergency-safe-guidance": ["紧急情况指导", "Emergency guidance"],
  "adas-alert-interrupt": ["安全提醒", "Safety alerts"],
  "wind-noise-robustness": ["风噪环境对话", "Conversation in windy conditions"],
  "degraded-network-recovery": ["弱网恢复", "Recovering from a weak connection"]
};

const TEST_CASE_INSTRUCTIONS: Record<string, [string, string]> = {
  "baseline-live-session": [
    "像平时一样与 Max 对话，确认能听清并理解回复。",
    "Speak to Max normally. Check that you can hear and understand the reply."
  ],
  "wake-word-addressed-only": [
    "先呼叫 Max，再尝试不呼叫名字直接说话。确认 Max 只在被呼叫时回应。",
    "Call Max by name, then try speaking without calling it. It should respond only when addressed."
  ],
  "emergency-safe-guidance": [
    "描述紧急情况，确认 Max 清楚地指导你减速、安全停车并寻求帮助。",
    "Describe an emergency. Check that Max gives clear advice to slow down, stop safely, and seek help."
  ],
  "adas-alert-interrupt": [
    "尝试安全提醒场景，确认 Max 及时打断对话并给出清楚的警告和安全建议。",
    "Try a safety-alert scenario. Max should interrupt promptly with a clear warning and safe action."
  ],
  "wind-noise-robustness": [
    "在有风或背景噪音时说话，确认 Max 仍能理解并清楚回复。",
    "Speak with wind or background noise. Check that Max understands you and replies clearly."
  ],
  "degraded-network-recovery": [
    "尝试弱网环境，确认 Max 能恢复连接，或清楚说明连接已断开。",
    "Try a weak network. Check that Max recovers or clearly explains that the connection was lost."
  ]
};

export function testingSessionTitle(
  session: Pick<TesterSessionSummary, "testCaseId" | "testCaseName">,
  language: Language = "zh-CN"
): string {
  const name = session.testCaseName?.trim();
  if (name && name !== session.testCaseId && name !== CATALOG_NAMES[session.testCaseId]) return name;
  const label = TEST_CASE_TITLES[session.testCaseId];
  return label ? localized(language, label[0], label[1]) : localized(language, "测试会话", "Test session");
}

export function testingTaskInstructions(
  testCaseId: string,
  description: string | undefined,
  language: Language
): string {
  const label = TEST_CASE_INSTRUCTIONS[testCaseId];
  return label
    ? localized(language, label[0], label[1])
    : description?.trim() ||
        localized(language, "请按照测试组织者提供的说明操作。", "Follow the instructions from your test organizer.");
}

const FEEDBACK_LABELS: Record<string, [string, string]> = {
  听错了: ["听错了", "Misheard"],
  回答不对: ["回答不对", "Wrong answer"],
  太慢: ["太慢", "Too slow"],
  不安全: ["不安全", "Unsafe"]
};

/** Turn-feedback reasons are tester-authored words, not system codes: known
 * presets localize, anything else stays exactly as the tester wrote it. */
export function testingFeedbackLabel(value: string, language: Language = "zh-CN"): string {
  const label = FEEDBACK_LABELS[value];
  return label ? localized(language, label[0], label[1]) : value;
}

const INVALID_REASON_LABELS: Record<string, [string, string]> = {
  "too-short": ["录音时长太短", "Recording was too short"],
  "missing-transcript": ["缺少对话记录", "Missing conversation transcript"],
  "missing-rider-turn": ["没有录到骑手说话", "No rider speech captured"],
  "missing-agent-turn": ["没有录到助手回复", "No assistant reply captured"],
  "missing-mic-audio": ["没有录到麦克风声音", "No microphone audio captured"]
};

export function testingInvalidReasonLabel(reason: string, language: Language = "zh-CN"): string {
  const label = INVALID_REASON_LABELS[reason];
  return label
    ? localized(language, label[0], label[1])
    : localized(language, "部分内容缺失", "Some content is missing");
}

type TestingSessionResult = {
  tone: TestingResultTone;
  label: string;
  reasons: string[];
};

/** The result a human should read for one session. An invalid recording is
 * never a pass: even when the automated evaluation says "pass", an incomplete
 * recording reads as "Incomplete recording" with plain-language reasons, and
 * empty evidence never renders as success. */
export function testingSessionResult(
  session: Pick<TesterSessionSummary, "quality" | "validity">,
  language: Language = "zh-CN"
): TestingSessionResult {
  if (session.validity?.status === "invalid") {
    const reasons = (session.validity.reasons ?? [])
      .map((reason) => testingInvalidReasonLabel(reason, language))
      .filter(Boolean);
    return {
      tone: "warn",
      label: localized(language, "记录不完整", "Incomplete recording"),
      reasons: reasons.length ? reasons : [localized(language, "部分内容缺失", "Some content is missing")]
    };
  }
  if (session.quality === "pass") {
    return { tone: "good", label: testingQualityLabel("pass", language), reasons: [] };
  }
  if (session.quality === "watch") {
    return { tone: "warn", label: testingQualityLabel("watch", language), reasons: [] };
  }
  return { tone: "alert", label: testingQualityLabel("fail", language), reasons: [] };
}
