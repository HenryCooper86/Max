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

  it("does not match the name embedded in a larger word", () => {
    expect(containsWakePhrase("maximum effort on the straight")).toBe(false);
    expect(containsWakePhrase("maximize the range")).toBe(false);
  });

  it("does not trigger without the name", () => {
    expect(containsWakePhrase("今天天气怎么样")).toBe(false);
    expect(containsWakePhrase("hey there, nice ride")).toBe(false);
    expect(containsWakePhrase("")).toBe(false);
  });
});
