import { describe, expect, it } from "vitest";
import { createLocalHelmetReply } from "../server/providers/ark";

describe("createLocalHelmetReply", () => {
  it("refuses unsupported languages", () => {
    expect(createLocalHelmetReply("가장 가까운 주유소")).toContain("我只支持");
  });

  it("answers fuel questions", () => {
    expect(createLocalHelmetReply("帮我找加油站")).toContain("油站");
  });

  it("answers weather questions phrased in English", () => {
    expect(createLocalHelmetReply("what is the weather ahead")).toContain("天气");
  });

  it("answers navigation questions", () => {
    expect(createLocalHelmetReply("帮我导航回家")).toMatch(/导航|路线/);
  });

  it("acknowledges a mic test", () => {
    expect(createLocalHelmetReply("测试，你能听见吗")).toContain("Max");
  });

  it("falls back to a generic safe reply", () => {
    expect(createLocalHelmetReply("讲个笑话")).toContain("收到");
  });
});
