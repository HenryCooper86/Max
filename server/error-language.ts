import type { NextFunction, Request, Response } from "express";

/**
 * English for the relay's HTTP error messages.
 *
 * The relay writes its errors in Chinese, the language it was first built
 * for, and they are shown to people as they are. A client that asks for
 * English (`Accept-Language: en…`, which the web app and the phone apps set
 * from their own language setting) gets the same error translated on the way
 * out. Everything else about the response is untouched, and a client that
 * asks for nothing gets exactly what it always did.
 *
 * Translating at the edge keeps one place that decides what went wrong (the
 * route) and one that decides how to say it in English (this table). A
 * message with no entry here goes out in Chinese rather than being dropped.
 */

const ENGLISH: Readonly<Record<string, string>> = {
  // Accounts
  "账号数据无法读取，请管理员检查服务器上的 accounts.json。":
    "The account data could not be read. Ask an administrator to check accounts.json on the server.",
  "邀请链接无效或已过期，请向管理员索取新邀请。":
    "This invitation is invalid or has expired. Ask an administrator for a new one.",
  "注册已关闭，请联系管理员。": "Registration is closed. Contact an administrator.",
  "用户名需为 3–32 位小写字母、数字、_ 或 -。":
    "The username must be 3–32 characters: lowercase letters, digits, _ or -.",
  "密码过长。": "The password is too long.",
  "用户名已被使用。": "That username is already taken.",
  "用户不存在。": "That user does not exist.",
  "不能删除管理员账号。": "An administrator account cannot be deleted.",
  "无效的账号角色。": "That account role is not valid.",
  "必须至少保留一个管理员账号。": "At least one administrator account must remain.",
  "用户名或密码不正确。": "Incorrect username or password.",
  "未登录或会话已过期。": "You are not signed in, or your session has expired.",
  "新密码过长。": "The new password is too long.",
  "当前密码不正确。": "The current password is incorrect.",
  "密码已修改，请使用当前密码重试。": "The password has already changed. Try again with the current password.",
  // Sign-in routes
  "尝试过于频繁，请稍后再试。": "Too many attempts. Please try again later.",
  "该中继需要邀请链接（或中继令牌）才能注册。": "This relay needs an invitation link (or the relay token) to register.",
  "注册失败，请重试。": "Registration failed. Please try again.",
  "登录失败，请重试。": "Sign-in failed. Please try again.",
  "修改失败，请重试。": "The change failed. Please try again.",
  // Administration
  "需要管理员登录。": "Administrator sign-in is required.",
  "邀请代码不能为空。": "The invitation code cannot be empty.",
  "不能修改当前登录账号的角色。": "You cannot change the role of the account you are signed in with.",
  "需要管理员登录或中继令牌。": "Administrator sign-in or the relay token is required.",
  // Testing workspace
  "需要登录后查看测试证据。": "Sign in to view test evidence.",
  "需要 QA 审核员或管理员权限。": "QA reviewer or administrator access is required.",
  "validity 必须为 valid 或 invalid。": "validity must be valid or invalid.",
  "测试会话不存在。": "That test session does not exist.",
  "测试运行不存在。": "That test run does not exist.",
  "已批准或已归档的发布记录不能重新打开。": "An approved or archived release record cannot be reopened.",
  "发布批准需要管理员权限。": "Approving a release needs administrator access.",
  "发布批准受 gate、覆盖、复核或回归证据阻止。":
    "Release approval is blocked by gate, coverage, review or regression evidence.",
  "任务受让人必须是已注册的 username。": "The assignee must be a registered username.",
  "测试运行或覆盖要求不存在。": "That test run or coverage requirement does not exist.",
  "测试任务不存在。": "That test task does not exist.",
  "复核证据会话不存在。": "That review evidence session does not exist.",
  "需要提供 sessionId。": "A sessionId is required.",
  "scope 必须为 all、tester（testerKey）或 session（sessionId）。":
    "scope must be all, tester (testerKey) or session (sessionId).",
  "接口不存在。": "That endpoint does not exist."
};

/** Messages that carry a number. */
const PATTERNS: readonly [RegExp, (match: RegExpExecArray) => string][] = [
  [/^密码至少 (\d+) 位。$/, (match) => `The password must be at least ${match[1]} characters.`],
  [/^新密码至少 (\d+) 位。$/, (match) => `The new password must be at least ${match[1]} characters.`]
];

/** The English for one of the relay's error messages, or undefined when it
 *  has none (the message then goes out as it is). */
export function englishError(message: string): string | undefined {
  const exact = ENGLISH[message];
  if (exact) return exact;
  for (const [pattern, render] of PATTERNS) {
    const match = pattern.exec(message);
    if (match) return render(match);
  }
  return undefined;
}

/** Whether an Accept-Language header asks for English first. Only the first
 *  language counts: "zh-CN, en;q=0.8" is a Chinese reader who can cope with
 *  English, not a request for it. */
export function prefersEnglish(acceptLanguage: string | undefined): boolean {
  const first = acceptLanguage?.split(",")[0]?.split(";")[0]?.trim().toLowerCase() ?? "";
  return first === "en" || first.startsWith("en-");
}

/** Express middleware: translates `error` in a JSON response for a client
 *  that asked for English. */
export function localizeErrors(req: Request, res: Response, next: NextFunction): void {
  if (prefersEnglish(req.headers["accept-language"])) {
    const send = res.json.bind(res);
    res.json = (body?: unknown) => {
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const error = (body as { error?: unknown }).error;
        const english = typeof error === "string" ? englishError(error) : undefined;
        if (english) return send({ ...body, error: english });
      }
      return send(body);
    };
  }
  next();
}
