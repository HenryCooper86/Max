import { describe, expect, it } from "vitest";
import { buildToolGroundingPrompt } from "../server/providers/doubao";
import { redactContactNames } from "../server/device-actions";

describe("buildToolGroundingPrompt", () => {
  const prompt = buildToolGroundingPrompt();

  it("declares the six real actions", () => {
    for (const capability of ["手电筒", "音量", "音乐", "短信", "电话", "目的地"]) {
      expect(prompt).toContain(capability);
    }
  });

  it("declares the camera actions", () => {
    for (const capability of ["拍照", "录像"]) {
      expect(prompt).toContain(capability);
    }
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
