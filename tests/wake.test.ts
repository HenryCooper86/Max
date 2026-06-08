import { describe, expect, it } from "vitest";
import { containsWakePhrase } from "../shared/wake";

describe("containsWakePhrase", () => {
  it("matches the canonical phrase", () => {
    expect(containsWakePhrase("Hey Max, what's the weather ahead?")).toBe(true);
  });

  it("tolerates punctuation and casing", () => {
    expect(containsWakePhrase("HEY, MAX! navigate home")).toBe(true);
    expect(containsWakePhrase("heymax are you there")).toBe(true);
  });

  it("accepts other greetings", () => {
    expect(containsWakePhrase("hi max")).toBe(true);
    expect(containsWakePhrase("ok max stop")).toBe(true);
  });

  it("accepts Chinese greetings before the name", () => {
    expect(containsWakePhrase("你好 Max，前面路况怎么样")).toBe(true);
    expect(containsWakePhrase("嘿 麦克斯")).toBe(true);
  });

  it("tolerates common mishearings of the name", () => {
    expect(containsWakePhrase("hey marks")).toBe(true);
    expect(containsWakePhrase("hey mac")).toBe(true);
  });

  it("does not trigger without a greeting", () => {
    expect(containsWakePhrase("max speed is 120")).toBe(false);
    expect(containsWakePhrase("what is the max range")).toBe(false);
  });

  it("does not match the 'hey max' substring inside other words", () => {
    expect(containsWakePhrase("they max out the rpm on the straight")).toBe(false);
    expect(containsWakePhrase("hey maximum effort")).toBe(false);
  });

  it("ignores unrelated greetings", () => {
    expect(containsWakePhrase("hey there, nice ride")).toBe(false);
    expect(containsWakePhrase("")).toBe(false);
  });
});
