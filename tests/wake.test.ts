import { describe, expect, it } from "vitest";
import { containsWakePhrase } from "../shared/wake";

describe("containsWakePhrase", () => {
  it("matches the bare name", () => {
    expect(containsWakePhrase("Max")).toBe(true);
    expect(containsWakePhrase("Max, what's the weather ahead?")).toBe(true);
  });

  it("matches the name anywhere in the utterance", () => {
    expect(containsWakePhrase("前面让 Max 看看路况")).toBe(true);
    expect(containsWakePhrase("navigate home Max")).toBe(true);
  });

  it("still accepts an optional greeting in front", () => {
    expect(containsWakePhrase("Hey Max, navigate home")).toBe(true);
    expect(containsWakePhrase("你好 Max，前面路况怎么样")).toBe(true);
    expect(containsWakePhrase("heymax are you there")).toBe(true);
  });

  it("tolerates punctuation and casing", () => {
    expect(containsWakePhrase("MAX! stop")).toBe(true);
    expect(containsWakePhrase("嘿 麦克斯")).toBe(true);
  });

  it("tolerates common mishearings of the name", () => {
    expect(containsWakePhrase("marks")).toBe(true);
    expect(containsWakePhrase("hey mac")).toBe(true);
  });

  it("matches the Chinese name inside an unspaced Han utterance", () => {
    expect(containsWakePhrase("麦克斯今天天气怎么样")).toBe(true);
    expect(containsWakePhrase("你好麦克斯帮我导航")).toBe(true);
    expect(containsWakePhrase("马克思前面堵吗")).toBe(true);
  });

  it("matches the Latin name glued to Chinese text", () => {
    expect(containsWakePhrase("max今天路况如何")).toBe(true);
    expect(containsWakePhrase("问一下Max现在几点")).toBe(true);
  });

  it("tolerates CJK punctuation and fullwidth forms", () => {
    expect(containsWakePhrase("Max。停一下")).toBe(true);
    expect(containsWakePhrase("麦克斯，导航回家")).toBe(true);
    expect(containsWakePhrase("Ｍａｘ 你在吗")).toBe(true);
  });

  it("does not match the name embedded in a larger word", () => {
    expect(containsWakePhrase("maximum effort on the straight")).toBe(false);
    expect(containsWakePhrase("maximize the range")).toBe(false);
  });

  it("does not match Chinese false friends that embed a name variant", () => {
    // 马克思主义 (Marxism) embeds 马克思; 麦克斯韦 (Maxwell) embeds 麦克斯.
    expect(containsWakePhrase("我在读马克思主义的书")).toBe(false);
    expect(containsWakePhrase("麦克斯韦方程很难")).toBe(false);
    // The bare name variants still wake outside those words.
    expect(containsWakePhrase("马克思前面堵吗")).toBe(true);
  });

  it("does not trigger without the name", () => {
    expect(containsWakePhrase("今天天气怎么样")).toBe(false);
    expect(containsWakePhrase("hey there, nice ride")).toBe(false);
    expect(containsWakePhrase("")).toBe(false);
  });
});
