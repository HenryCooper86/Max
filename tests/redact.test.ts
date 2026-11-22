import { describe, expect, it } from "vitest";
import { REDACTION_KINDS, redactText, redactTurns, redactionKindsFrom } from "../server/redact";

const all = REDACTION_KINDS;

describe("redactionKindsFrom", () => {
  it("reads every form", () => {
    expect(redactionKindsFrom(true).kinds).toEqual([...REDACTION_KINDS]);
    expect(redactionKindsFrom("all").kinds).toEqual([...REDACTION_KINDS]);
    expect(redactionKindsFrom(["phone", "Email", "phone"])).toEqual({ kinds: ["email", "phone"] });
    for (const none of [false, undefined, null, [], "none"]) expect(redactionKindsFrom(none)).toEqual({ kinds: [] });
  });

  it("reports unknown entries", () => {
    expect(redactionKindsFrom(["email", "passport"]).problem).toMatch(/passport/);
    expect(redactionKindsFrom("everything").problem).toBeTruthy();
    expect(redactionKindsFrom(42).problem).toBeTruthy();
    expect(redactionKindsFrom([3]).problem).toBeTruthy();
  });
});

describe("email", () => {
  it("redacts ordinary addresses", () => {
    expect(redactText("write to bob.smith+tag@mail.example.co.uk, thanks", ["email"])).toBe("write to [email], thanks");
    expect(redactText("a@b.io and c_d@e-f.com.", ["email"])).toBe("[email] and [email].");
  });
  it("leaves non-addresses alone", () => {
    for (const text of ["meet @ noon", "@handle", "a@b", "me@ example.com", "user@.com", "x@y.z"])
      expect(redactText(text, ["email"])).toBe(text);
  });
});

describe("card", () => {
  it("redacts Luhn-valid numbers in several layouts", () => {
    expect(redactText("it is 4111111111111111 ok", ["card"])).toBe("it is [card] ok");
    expect(redactText("4111 1111 1111 1111", ["card"])).toBe("[card]");
    expect(redactText("4111-1111-1111-1111.", ["card"])).toBe("[card].");
    expect(redactText("378282246310005", ["card"])).toBe("[card]");
    expect(redactText("4 1 1 1 1 1 1 1 1 1 1 1 1 1 1 1", ["card"])).toBe("[card]");
  });
  it("needs the Luhn check and 13-19 digits", () => {
    expect(redactText("4111111111111112", ["card"])).toBe("4111111111111112");
    expect(redactText("79927398713", ["card"])).toBe("79927398713");
    expect(redactText("order 1234567890123456789012", ["card"])).toBe("order 1234567890123456789012");
  });
  it("is applied before phone", () => {
    expect(redactText("pay with 4111 1111 1111 1111 now", all)).toBe("pay with [card] now");
  });
});

describe("ssn", () => {
  it("redacts valid numbers", () => expect(redactText("ssn 123-45-6789.", ["ssn"])).toBe("ssn [ssn]."));
  it("skips impossible prefixes and other shapes", () => {
    for (const text of [
      "000-12-3456",
      "666-12-3456",
      "900-12-3456",
      "123-00-6789",
      "123-45-0000",
      "123-456-789",
      "1234-56-7890"
    ])
      expect(redactText(text, ["ssn"])).toBe(text);
  });
});

describe("ip", () => {
  it("redacts IPv4 and IPv6", () => {
    expect(redactText("from 192.168.1.20 and 8.8.8.8.", ["ip"])).toBe("from [ip] and [ip].");
    expect(redactText("at 2001:0db8:85a3:0000:0000:8a2e:0370:7334 now", ["ip"])).toBe("at [ip] now");
    expect(redactText("host 2001:db8::1, gw fe80::1", ["ip"])).toBe("host [ip], gw [ip]");
    expect(redactText("loopback ::1", ["ip"])).toBe("loopback [ip]");
  });
  it("leaves lookalikes alone", () => {
    for (const text of [
      "256.1.1.1",
      "1.2.3",
      "version 1.2.3.4.5",
      "v1.2.3.4",
      "12:30:45",
      "std::vector",
      "at 10:15",
      "::"
    ])
      expect(redactText(text, ["ip"])).toBe(text);
  });
});

describe("phone", () => {
  it("redacts international and national formats", () => {
    expect(redactText("call +1 415 555 2671 now", ["phone"])).toBe("call [phone] now");
    expect(redactText("+442071838750", ["phone"])).toBe("[phone]");
    expect(redactText("(415) 555-2671", ["phone"])).toBe("[phone]");
    expect(redactText("415-555-2671.", ["phone"])).toBe("[phone].");
    expect(redactText("415.555.2671", ["phone"])).toBe("[phone]");
    expect(redactText("555-1234", ["phone"])).toBe("[phone]");
    expect(redactText("it's 4 1 5 5 5 5 2 6 7 1", ["phone"])).toBe("it's [phone]");
  });
  it("does not touch short numbers, prices, dates, order numbers or times", () => {
    for (const text of [
      "12345",
      "1234567",
      "$1,299.00",
      "1.234.567",
      "2026-11-22",
      "22-11-2026",
      "22/11/2026",
      "A-1042",
      "ORD-2026-1105-33",
      "at 10:30",
      "3 pm on the 5th",
      "I have 3 or 4 of them",
      "in 2025. 12 left"
    ])
      expect(redactText(text, ["phone"])).toBe(text);
  });
  it("keeps a date and a time apart", () => {
    expect(redactText("on 2026-11-22 10:30", all)).toBe("on 2026-11-22 10:30");
  });
});

describe("redactText", () => {
  it("does nothing without kinds", () =>
    expect(redactText("a@b.com 4111111111111111", [])).toBe("a@b.com 4111111111111111"));
  it("applies only the kinds asked for", () =>
    expect(redactText("a@b.com 123-45-6789", ["email"])).toBe("[email] 123-45-6789"));
  it("handles a mix", () =>
    expect(redactText("mail a@b.com, ssn 123-45-6789, ip 10.0.0.1, +1 415 555 2671", all)).toBe(
      "mail [email], ssn [ssn], ip [ip], [phone]"
    ));
});

describe("redactTurns", () => {
  it("returns new turns and leaves the input alone", () => {
    const turns = [
      { at: 1, speaker: "user" as const, text: "mail a@b.com" },
      { at: 2, speaker: "agent" as const, text: "ok", ms: 3 }
    ];
    const out = redactTurns(turns, ["email"]);
    expect(out).toEqual([
      { at: 1, speaker: "user", text: "mail [email]" },
      { at: 2, speaker: "agent", text: "ok", ms: 3 }
    ]);
    expect(out[0]).not.toBe(turns[0]);
    expect(turns[0]!.text).toBe("mail a@b.com");
  });
});

describe("running time", () => {
  it("is linear on adversarial input", () => {
    const inputs = [
      "a".repeat(100_000),
      "1 ".repeat(50_000),
      "1-".repeat(50_000),
      "1.".repeat(50_000),
      "a@".repeat(50_000),
      "a.".repeat(50_000) + "@",
      "1:".repeat(50_000),
      "f".repeat(100_000),
      ":".repeat(100_000),
      "(1) ".repeat(25_000)
    ];
    const started = Date.now();
    for (const input of inputs) redactText(input, all);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
