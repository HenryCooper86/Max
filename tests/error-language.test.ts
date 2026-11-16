import fs from "node:fs";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { englishError, localizeErrors, prefersEnglish } from "../server/error-language";

const CHINESE = /[一-鿿]/;

/** Every Chinese `error: "…"` literal in a server source file. */
function chineseErrors(file: string): string[] {
  const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const found: string[] = [];
  for (const match of source.matchAll(
    /error:\s*(?:\w+\s*\?\s*)?(["`])((?:(?!\1).)*)\1(?:\s*:\s*(["`])((?:(?!\3).)*)\3)?/g
  )) {
    for (const text of [match[2], match[4]]) if (text && CHINESE.test(text)) found.push(text);
  }
  return found;
}

describe("relay errors in English", () => {
  it("has English for every error the account and HTTP routes can send", () => {
    const messages = [...chineseErrors("server/accounts.ts"), ...chineseErrors("server/index.ts")];
    expect(messages.length).toBeGreaterThan(40);
    // A template's ${…} stands for a number.
    const missing = messages.map((text) => text.replace(/\$\{[^}]+\}/g, "8")).filter((text) => !englishError(text));
    expect(missing).toEqual([]);
  });

  it("leaves nothing Chinese in a translation and keeps the number", () => {
    expect(englishError("用户名或密码不正确。")).toBe("Incorrect username or password.");
    expect(englishError("密码至少 8 位。")).toBe("The password must be at least 8 characters.");
    expect(englishError("新密码至少 12 位。")).toContain("12");
    expect(englishError("没有翻译的消息")).toBeUndefined();
  });

  it("reads only the first language of Accept-Language", () => {
    expect(prefersEnglish("en-US,en;q=0.9")).toBe(true);
    expect(prefersEnglish("en")).toBe(true);
    expect(prefersEnglish("zh-CN,zh;q=0.9,en;q=0.8")).toBe(false);
    expect(prefersEnglish("*")).toBe(false);
    expect(prefersEnglish(undefined)).toBe(false);
  });

  describe("middleware", () => {
    let close: (() => void) | undefined;
    afterEach(() => close?.());

    async function ask(language?: string) {
      const app = express();
      app.use(localizeErrors);
      app.get("/refused", (_req, res) => {
        res.status(401).json({ ok: false, error: "用户名或密码不正确。", detail: "kept" });
      });
      app.get("/unknown", (_req, res) => {
        res.status(400).json({ ok: false, error: "没有翻译的消息" });
      });
      app.get("/fine", (_req, res) => {
        res.json({ ok: true, items: ["用户名或密码不正确。"] });
      });
      const server = app.listen(0);
      close = () => server.close();
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const headers: Record<string, string> = {
        Connection: "close",
        ...(language ? { "Accept-Language": language } : {})
      };
      const get = async (route: string) => {
        const response = await fetch(base + route, { headers });
        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
      };
      return { refused: await get("/refused"), unknown: await get("/unknown"), fine: await get("/fine") };
    }

    it("translates the error for an English client and nothing else", async () => {
      const { refused, unknown, fine } = await ask("en-US");
      expect(refused).toEqual({
        status: 401,
        body: { ok: false, error: "Incorrect username or password.", detail: "kept" }
      });
      expect(unknown.body.error).toBe("没有翻译的消息");
      expect(fine.body).toEqual({ ok: true, items: ["用户名或密码不正确。"] });
    });

    it("answers as before when the client asks for Chinese or for nothing", async () => {
      expect((await ask("zh-CN")).refused.body.error).toBe("用户名或密码不正确。");
      close?.();
      expect((await ask()).refused.body.error).toBe("用户名或密码不正确。");
    });
  });
});
