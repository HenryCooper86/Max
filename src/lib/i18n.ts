export type Language = "zh-CN" | "en-US";

export const DEFAULT_LANGUAGE: Language = "zh-CN";
export const LANGUAGE_STORAGE_KEY = "max.ui.language.v1";

const DICTIONARIES = {
  "zh-CN": {
    "settings.title": "设置",
    "login.welcome": "欢迎使用 {product}",
    "language.chinese": "中文",
    "language.english": "EN",
    "language.label": "界面语言",
    "language.englishAria": "切换到英文",
    "language.chineseAria": "切换到中文",
    "app.loadingAdmin": "正在加载测试与管理…",
    "voice.viewLabel": "语音助手视图",
    "voice.captions": "字幕",
    "voice.settings": "设置",
    "voice.connecting": "正在连接免提",
    "voice.stopHandsFree": "结束免提",
    "voice.startHandsFree": "开始免提",
    "voice.connectingShort": "连接中",
    "voice.spaceKey": "空格键",
    "voice.offline": "离线",
    "voice.state.idle": "待机",
    "voice.state.listening": "免提待命 · 请讲话",
    "voice.state.hearing": "正在聆听…",
    "voice.state.thinking": "Max 思考中…",
    "voice.state.speaking": "Max 回答中",
    "voice.hazard.caution": "注意路况",
    "voice.hazard.critical": "高风险 · 优先安全",
    "login.aria": "登录",
    "login.brand": "Max 摩托车头盔 AI",
    "login.platform": "内部测试平台",
    "login.firstUse": "首次使用：注册第一个账号，该账号将成为管理员。",
    "login.invite": "你收到了一个邀请 — 注册你的测试账号即可进入。",
    "login.openRegistration": "登录后进入语音测试座舱；没有账号可以注册（需管理员知晓）。",
    "login.closedRegistration": "登录后进入语音测试座舱。注册已关闭 — 需要账号请联系管理员。",
    "login.accessFootnote": "HORIZON CONTINENTAL TECHNOLOGY · SECURE ACCESS",
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
    "transcript.greeting": "你好，我是 Max。",
    "transcript.help": "开启免提后直接讲话。我可以帮你查看天气、路线和骑行状态。"
  },
  "en-US": {
    "settings.title": "Settings",
    "login.welcome": "Welcome to {product}",
    "language.chinese": "中文",
    "language.english": "EN",
    "language.label": "Interface language",
    "language.englishAria": "Switch to English",
    "language.chineseAria": "Switch to Chinese",
    "app.loadingAdmin": "Loading testing and admin…",
    "voice.viewLabel": "Voice assistant views",
    "voice.captions": "Captions",
    "voice.settings": "Settings",
    "voice.connecting": "Connecting hands-free",
    "voice.stopHandsFree": "End hands-free",
    "voice.startHandsFree": "Start hands-free",
    "voice.connectingShort": "Connecting",
    "voice.spaceKey": "Space",
    "voice.offline": "Offline",
    "voice.state.idle": "Standby",
    "voice.state.listening": "Hands-free ready · speak now",
    "voice.state.hearing": "Listening…",
    "voice.state.thinking": "Max is thinking…",
    "voice.state.speaking": "Max is responding",
    "voice.hazard.caution": "Watch the road",
    "voice.hazard.critical": "High risk · safety first",
    "login.aria": "Sign in",
    "login.brand": "Max Motorcycle Helmet AI",
    "login.platform": "Internal testing platform",
    "login.firstUse": "First use: register the first account; it becomes the administrator.",
    "login.invite": "You received an invitation — register your tester account to continue.",
    "login.openRegistration": "Sign in to enter the voice testing cockpit; registration is available with administrator approval.",
    "login.closedRegistration": "Sign in to enter the voice testing cockpit. Registration is closed — contact an administrator.",
    "login.accessFootnote": "HORIZON CONTINENTAL TECHNOLOGY · SECURE ACCESS",
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
    "transcript.greeting": "Hi, I'm Max.",
    "transcript.help": "Turn on hands-free and speak naturally. I can help with weather, routes, and ride status."
  }
} as const;

export type TranslationKey = keyof (typeof DICTIONARIES)["zh-CN"];
export type Translator = (key: TranslationKey, params?: Record<string, string | number>) => string;

export function readStoredLanguage(storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage): Language {
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

export function persistLanguage(language: Language, storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage) {
  try {
    storage?.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // UI preference persistence is best effort; the active language still applies.
  }
}
