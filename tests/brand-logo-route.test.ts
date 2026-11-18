import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { sendBrandLogo } from "../server/brand-logo-route";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';

describe("the logo route", () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => cleanup?.());

  async function get(file: string | undefined) {
    const app = express();
    app.get("/brand/logo", (_req, res) => {
      sendBrandLogo(res, file ? { path: file, contentType: "image/svg+xml", version: "1" } : undefined);
    });
    const server = app.listen(0);
    const close = cleanup;
    cleanup = () => {
      server.close();
      close?.();
    };
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/brand/logo`, { headers: { Connection: "close" } });
    return { response, body: await response.text() };
  }

  it("serves a logo kept under a dot directory, where the Studio stores it", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "logo-route-"));
    cleanup = () => fs.rmSync(home, { recursive: true, force: true });
    const directory = path.join(home, ".max-relay");
    fs.mkdirSync(directory);
    const file = path.join(directory, "brand-logo.svg");
    fs.writeFileSync(file, SVG);

    const { response, body } = await get(file);
    expect(response.status).toBe(200);
    expect(body).toBe(SVG);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
  });

  it("lets a fixed address, like the favicon's, ask the browser to check back", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "logo-route-"));
    cleanup = () => fs.rmSync(home, { recursive: true, force: true });
    const file = path.join(home, "brand-logo.svg");
    fs.writeFileSync(file, SVG);
    const app = express();
    app.get("/favicon.ico", (_req, res) => {
      sendBrandLogo(res, { path: file, contentType: "image/svg+xml", version: "1" }, "no-cache");
    });
    const server = app.listen(0);
    const close = cleanup;
    cleanup = () => {
      server.close();
      close?.();
    };
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/favicon.ico`, { headers: { Connection: "close" } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(SVG);
    expect(response.headers.get("content-type")).toContain("image/svg+xml");
    expect(response.headers.get("cache-control")).toBe("no-cache");
  });

  it("answers a missing file, or no logo at all, with an uncached 404", async () => {
    for (const file of [path.join(os.tmpdir(), "no-such-logo-file.svg"), undefined]) {
      const { response, body } = await get(file);
      expect(response.status).toBe(404);
      expect(JSON.parse(body)).toEqual({ ok: false });
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});
