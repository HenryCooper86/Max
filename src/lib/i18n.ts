import type { AssistantDevice } from "../../shared/agent";

export type Language = "zh-CN" | "en-US";

export const DEFAULT_LANGUAGE: Language = "zh-CN";
export const LANGUAGE_STORAGE_KEY = "max.ui.language.v1";

const DICTIONARIES = {
  "zh-CN": {
    "settings.title": "设置",
    "settings.assistant": "助手",
    "settings.assistantName": "名称",
    "settings.device": "设备",
    "settings.wakePhrase": "唤醒词",
    "settings.wakeOff": "未启用，直接说话即可",
    "settings.voiceBackend": "语音后端",
    "settings.voiceBackendHelp": "切换后，当前会话会重新连接。",
    "settings.voiceBackendFixed": "由服务器设定",
    "settings.liveBackend": "当前会话使用",
    "settings.liveBackendNone": "会话未开启",
    "settings.needsKey": "需要 API 密钥",
    "settings.backendKind.demo": "演示",
    "settings.backendKind.live": "实时",
    "settings.backendKind.pipeline": "管线",
    "settings.voice": "语音",
    "settings.voiceHelp": "选择 {name} 的声音和回答风格",
    "settings.ride.helmet": "骑行",
    "settings.ride.glasses": "活动",
    "settings.ride.other": "活动",
    "settings.rideHelp": "模式和当前态势",
    "settings.weather": "天气",
    "settings.weatherHelp": "根据你的位置实时更新",
    "settings.connection": "连接",
    "settings.export": "导出对话",
    "settings.clear": "清空对话",
    "settings.done": "完成",
    "settings.doneAria": "完成并关闭设置",
    "settings.workspaces": "测试与管理",
    "settings.testing": "测试",
    "settings.testingHelp": "测试计划、对话记录和反馈",
    "settings.admin": "管理",
    "settings.adminHelp": "账号、角色、邀请和审计历史",
    "voice.assistantKind.helmet": "头盔语音助手",
    "voice.assistantKind.glasses": "智能眼镜语音助手",
    "voice.assistantKind.other": "可穿戴语音助手",
    "login.welcome": "欢迎使用 {product}",
    "language.chinese": "中文",
    "language.english": "EN",
    "language.label": "界面语言",
    "language.englishAria": "切换到英文",
    "language.chineseAria": "切换到中文",
    "voice.viewLabel": "语音助手视图",
    "voice.captions": "字幕",
    "voice.settings": "设置",
    "voice.connecting": "正在连接免提",
    "voice.stopHandsFree": "结束免提",
    "voice.startHandsFree": "开始免提",
    "voice.connectingShort": "连接中",
    "voice.setupShort": "正在准备麦克风",
    "voice.micLive": "麦克风已开启",
    "voice.micOff": "麦克风已关闭",
    "voice.spaceKey": "空格",
    "voice.offline": "离线",
    "voice.offlineHint": "语音连接已断开，正在重试。",
    "voice.sessionConnected": "语音已连接",
    "voice.sessionInactive": "未开启",
    "voice.welcome": "你好，我是 {name}",
    "voice.startHint.helmet": "开启免提，问天气、查路线或开始骑行。",
    "voice.startHint.glasses": "开启免提，问天气、查路线，或问问眼前的东西。",
    "voice.startHint.other": "开启免提，问天气、查路线或随时提问。",
    "voice.setupHint": "正在准备麦克风与语音连接，可再次点击取消。",
    "voice.wakeHint": "先说“{wake}”，再说你的问题。",
    "voice.openMicHint": "直接说出你的问题。",
    "voice.interruptHint": "随时开口即可打断。",
    "voice.state.idle": "待机",
    "voice.state.listening": "免提待命 · 请讲话",
    "voice.state.hearing": "正在聆听…",
    "voice.state.thinking": "{name} 思考中…",
    "voice.state.speaking": "{name} 回答中",
    "voice.hazard.caution": "注意路况",
    "voice.hazard.critical": "高风险 · 优先安全",
    "voice.assistantLabel.helmet": "{name} 头盔语音助手",
    "voice.assistantLabel.glasses": "{name} 智能眼镜语音助手",
    "voice.assistantLabel.other": "{name} 语音助手",
    "login.aria": "登录",
    "login.platform": "内部测试平台",
    "login.firstUse": "首次使用：注册第一个账号，该账号将成为管理员。",
    "login.invite": "你收到了一个邀请，注册测试账号即可进入。",
    "login.openRegistration": "登录后进入语音测试；没有账号可以注册（需管理员知晓）。",
    "login.closedRegistration": "登录后进入语音测试。注册已关闭，需要账号请联系管理员。",
    "account.loginOrRegister": "登录或注册",
    "account.username": "用户名",
    "account.password": "密码",
    "account.passwordMin": "密码（至少 8 位）",
    "account.displayName": "显示名（可选）",
    "account.login": "登录",
    "account.register": "注册",
    "account.haveAccount": "已有账号？登录",
    "account.registerNew": "注册新账号",
    "account.registerAdmin": "注册第一个账号（管理员）",
    "account.copyToken": "复制令牌（App 用）",
    "account.copied": "已复制 ✓",
    "account.changePassword": "修改密码",
    "account.changePasswordAria": "修改密码",
    "account.currentPassword": "当前密码",
    "account.newPassword": "新密码（至少 8 位）",
    "account.confirmPassword": "确认修改",
    "account.changingPassword": "修改中…",
    "account.cancel": "取消",
    "account.passwordChanged": "密码已修改 ✓",
    "account.copyFailed": "无法复制会话令牌。",
    "account.memoryCleared": "记忆已清除 ✓",
    "account.memoryClearFailed": "清除记忆失败",
    "account.confirmMemoryClear": "确认清除记忆?",
    "account.memory": "记忆…",
    "account.memorySummary": "记忆 {turns} 段{facts}",
    "account.memoryFactSuffix": "条重点",
    "account.memoryHelp": "清除 {name} 为此账号保存的跨会话记忆",
    "account.passwordChangeFailed": "修改失败，请重试。",
    "account.logout": "退出登录",
    "account.roleAdmin": "管理员",
    "account.roleReviewer": "审核员",
    "account.roleTester": "测试员",
    "transcript.aria": "实时字幕",
    "transcript.title": "实时字幕",
    "transcript.waiting": "等待对话",
    "transcript.items": "{count} 条",
    "transcript.you": "你",
    "transcript.live": "实时",
    "transcript.flag": "标记这条对话",
    "transcript.feedbackReasons": "反馈原因",
    "transcript.greeting": "对话字幕会显示在这里",
    "transcript.help.helmet": "开启免提后直接讲话。我可以帮你查看天气、路线和骑行状态。",
    "transcript.help.glasses": "开启免提后直接讲话。我可以帮你查看天气、路线和周围的情况。",
    "transcript.help.other": "开启免提后直接讲话。我可以帮你查看天气、路线，回答你的问题。"
  },
  "en-US": {
    "settings.title": "Settings",
    "settings.assistant": "Assistant",
    "settings.assistantName": "Name",
    "settings.device": "Device",
    "settings.wakePhrase": "Wake phrase",
    "settings.wakeOff": "Off, just speak",
    "settings.voiceBackend": "Voice backend",
    "settings.voiceBackendHelp": "Switching reconnects the current session.",
    "settings.voiceBackendFixed": "Set by the server",
    "settings.liveBackend": "Session is using",
    "settings.liveBackendNone": "No session",
    "settings.needsKey": "Needs API key",
    "settings.backendKind.demo": "Demo",
    "settings.backendKind.live": "Live",
    "settings.backendKind.pipeline": "Pipeline",
    "settings.voice": "Voice",
    "settings.voiceHelp": "Choose {name}'s voice and response style",
    "settings.ride.helmet": "Ride",
    "settings.ride.glasses": "Activity",
    "settings.ride.other": "Activity",
    "settings.rideHelp": "Mode and current conditions",
    "settings.weather": "Weather",
    "settings.weatherHelp": "Updates from your location",
    "settings.connection": "Connection",
    "settings.export": "Export conversation",
    "settings.clear": "Clear conversation",
    "settings.done": "Done",
    "settings.doneAria": "Finish and close settings",
    "settings.workspaces": "Testing and administration",
    "settings.testing": "Testing",
    "settings.testingHelp": "Test plans, conversations, and feedback",
    "settings.admin": "Administration",
    "settings.adminHelp": "Accounts, roles, invitations, and audit history",
    "voice.assistantKind.helmet": "Helmet voice assistant",
    "voice.assistantKind.glasses": "Smart-glasses voice assistant",
    "voice.assistantKind.other": "Wearable voice assistant",
    "login.welcome": "Welcome to {product}",
    "language.chinese": "中文",
    "language.english": "EN",
    "language.label": "Interface language",
    "language.englishAria": "Switch to English",
    "language.chineseAria": "Switch to Chinese",
    "voice.viewLabel": "Voice assistant views",
    "voice.captions": "Captions",
    "voice.settings": "Settings",
    "voice.connecting": "Connecting hands-free",
    "voice.stopHandsFree": "End hands-free",
    "voice.startHandsFree": "Start hands-free",
    "voice.connectingShort": "Connecting",
    "voice.setupShort": "Preparing microphone",
    "voice.micLive": "Microphone on",
    "voice.micOff": "Microphone off",
    "voice.spaceKey": "Space",
    "voice.offline": "Offline",
    "voice.offlineHint": "The voice connection dropped. Retrying.",
    "voice.sessionConnected": "Voice connected",
    "voice.sessionInactive": "Not started",
    "voice.welcome": "Hi, I'm {name}",
    "voice.startHint.helmet": "Start hands-free for weather, routes, and your ride.",
    "voice.startHint.glasses": "Start hands-free for weather, routes, or what's in front of you.",
    "voice.startHint.other": "Start hands-free for weather, routes, or any question.",
    "voice.setupHint": "Preparing your microphone and voice connection. Tap again to cancel.",
    "voice.wakeHint": "Say “{wake}”, then ask your question.",
    "voice.openMicHint": "Just ask your question.",
    "voice.interruptHint": "Speak any time to interrupt.",
    "voice.state.idle": "Standby",
    "voice.state.listening": "Hands-free ready · speak now",
    "voice.state.hearing": "Listening…",
    "voice.state.thinking": "{name} is thinking…",
    "voice.state.speaking": "{name} is responding",
    "voice.hazard.caution": "Watch the road",
    "voice.hazard.critical": "High risk · safety first",
    "voice.assistantLabel.helmet": "{name} helmet voice assistant",
    "voice.assistantLabel.glasses": "{name} smart-glasses voice assistant",
    "voice.assistantLabel.other": "{name} voice assistant",
    "login.aria": "Sign in",
    "login.platform": "Internal testing platform",
    "login.firstUse": "First use: register the first account; it becomes the administrator.",
    "login.invite": "You received an invitation. Register your tester account to continue.",
    "login.openRegistration":
      "Sign in to start voice testing. You can register an account with administrator approval.",
    "login.closedRegistration":
      "Sign in to start voice testing. Registration is closed; ask an administrator for an account.",
    "account.loginOrRegister": "Sign in or register",
    "account.username": "Username",
    "account.password": "Password",
    "account.passwordMin": "Password (8+ characters)",
    "account.displayName": "Display name (optional)",
    "account.login": "Sign in",
    "account.register": "Register",
    "account.haveAccount": "Already have an account? Sign in",
    "account.registerNew": "Register a new account",
    "account.registerAdmin": "Register the first account (administrator)",
    "account.copyToken": "Copy token (App)",
    "account.copied": "Copied ✓",
    "account.changePassword": "Change password",
    "account.changePasswordAria": "Change password",
    "account.currentPassword": "Current password",
    "account.newPassword": "New password (8+ characters)",
    "account.confirmPassword": "Confirm change",
    "account.changingPassword": "Changing…",
    "account.cancel": "Cancel",
    "account.passwordChanged": "Password changed ✓",
    "account.copyFailed": "Unable to copy the session token.",
    "account.memoryCleared": "Memory cleared ✓",
    "account.memoryClearFailed": "Memory clear failed",
    "account.confirmMemoryClear": "Confirm clearing memory?",
    "account.memory": "Memory…",
    "account.memorySummary": "Memory {turns} turns{facts}",
    "account.memoryFactSuffix": "key facts",
    "account.memoryHelp": "Clear {name}'s saved cross-session memory for this account",
    "account.passwordChangeFailed": "Password change failed. Please try again.",
    "account.logout": "Sign out",
    "account.roleAdmin": "Administrator",
    "account.roleReviewer": "Reviewer",
    "account.roleTester": "Tester",
    "transcript.aria": "Live captions",
    "transcript.title": "Live captions",
    "transcript.waiting": "Waiting for conversation",
    "transcript.items": "{count} items",
    "transcript.you": "You",
    "transcript.live": "Live",
    "transcript.flag": "Flag this conversation",
    "transcript.feedbackReasons": "Feedback reasons",
    "transcript.greeting": "Your conversation appears here",
    "transcript.help.helmet":
      "Turn on hands-free and speak naturally. I can help with weather, routes, and ride status.",
    "transcript.help.glasses":
      "Turn on hands-free and speak naturally. I can help with weather, routes, and what's around you.",
    "transcript.help.other":
      "Turn on hands-free and speak naturally. I can help with weather, routes, and your questions."
  }
} as const;

type TranslationKey = keyof (typeof DICTIONARIES)["zh-CN"];
export type Translator = (key: TranslationKey, params?: Record<string, string | number>) => string;

type DeviceCopyPrefix =
  "voice.assistantKind" | "voice.startHint" | "voice.assistantLabel" | "settings.ride" | "transcript.help";

/** Copy that differs by wearable (helmet, glasses, other) lives under
 *  `<prefix>.<device>`; every prefix here has all three variants. */
export function deviceCopyKey(prefix: DeviceCopyPrefix, device: AssistantDevice): TranslationKey {
  return `${prefix}.${device}` as TranslationKey;
}

export function localized(language: Language, chinese: string, english: string): string {
  return language === "en-US" ? english : chinese;
}

export function readStoredLanguage(
  storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage
): Language {
  try {
    const value = storage?.getItem(LANGUAGE_STORAGE_KEY);
    return value === "en-US" || value === "zh-CN" ? value : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function createTranslator(language: Language): Translator {
  return (key, params = {}) => {
    const template = DICTIONARIES[language][key] ?? DICTIONARIES[DEFAULT_LANGUAGE][key];
    return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`));
  };
}

export function persistLanguage(
  language: Language,
  storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage
) {
  try {
    storage?.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // UI preference persistence is best effort; the active language still applies.
  }
}
