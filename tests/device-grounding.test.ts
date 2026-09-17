import { describe, expect, it } from "vitest";
import { buildToolGroundingPrompt } from "../server/providers/doubao";
import { redactContactNames } from "../server/device-actions";

describe("buildToolGroundingPrompt", () => {
  const prompt = buildToolGroundingPrompt();

  it("declares the six real actions", () => {
    for (const capability of ["手电筒", "音量", "音乐", "短信", "电话", "语音导航"]) {
      expect(prompt).toContain(capability);
    }
  });

  it("explains QQ platform limits without claiming handoff means playback", () => {
    expect(prompt).toContain("QQ 音乐在 Android");
    expect(prompt).toContain("iOS 和网页目前仅提供官网入口");
    expect(prompt).toContain("打开官网不代表播放成功");
  });

  it("declares the camera actions", () => {
    for (const capability of ["拍照", "录像"]) {
      expect(prompt).toContain(capability);
    }
  });

  it("declares live navigation and no longer excludes it", () => {
    expect(prompt).toContain("语音导航");
    expect(prompt).not.toContain("逐向导航语音");
  });

  it("authorizes hands-free actions while riding, overriding any stop-first framing", () => {
    // The server's protected .env may still carry the old "distraction → stop
    // first" system role; this always-appended prompt must countermand it so Max
    // never refuses voice-triggered capture/navigation while riding.
    expect(prompt).toContain("直接执行");
    expect(prompt).toContain("不要当作分心请求");
    expect(prompt).toContain("这一条优先");
  });

  it("still forbids the capabilities we do not have", () => {
    for (const missing of ["实时交通", "车辆", "小队"]) {
      expect(prompt).toContain(missing);
    }
  });

  it("keeps the success-only rule", () => {
    expect(prompt).toContain("系统");
    expect(prompt).toContain("成功");
  });

  it("forbids the model from narrating navigation it was not given", () => {
    // The same block tells the model never to refuse a navigation request. That
    // must not read as licence to invent one when the pipeline fails — which is
    // exactly what happened on h2o on 2026-08-16.
    expect(prompt).toContain("不要自己编造");
    expect(prompt).toContain("导航提示");
  });

  it("keeps the anti-fabrication rule where a deployment override cannot drop it", () => {
    // DEFAULT_AGENT_SYSTEM_PROMPT is replaceable via DOUBAO_SYSTEM_ROLE; this
    // block is always appended, so the rule must live here and not there.
    expect(buildToolGroundingPrompt()).toContain("不要自己编造");
  });
});

describe("redactContactNames", () => {
  it("redacts the callee in a Chinese dial request", () => {
    expect(redactContactNames("Max 打给老王")).toBe("Max 打给[联系人]");
  });

  it("redacts the recipient but keeps the message body", () => {
    expect(redactContactNames("Max 给老王发条短信说我晚点到")).toBe("Max 给[联系人]发条短信说我晚点到");
  });

  it("redacts an English callee", () => {
    expect(redactContactNames("Max call Wang")).toBe("Max call [联系人]");
  });

  it("leaves emergency numbers and non-command text alone", () => {
    expect(redactContactNames("Max 报警")).toBe("Max 报警");
    expect(redactContactNames("Max 今天天气怎么样")).toBe("Max 今天天气怎么样");
  });
});
