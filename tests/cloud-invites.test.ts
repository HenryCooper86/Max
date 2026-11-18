// Max Cloud signup is by invitation, like the testing platform's accounts.
import { randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setCloudClock } from "../server/cloud/context";
import { createInvite, listInvites, login, revokeInvite, signup } from "../server/cloud/customers";
import { resetCloudDatabase } from "../server/cloud/store";
import { AuthCard, inviteFromLocation } from "../src/console/AuthCard";
import { LanguageProvider } from "../src/components/LanguageToggle";

const START = Date.UTC(2026, 10, 18, 12, 0, 0);
let clock = START;
const saved = { key: process.env.CLOUD_SECRET_KEY, signup: process.env.CLOUD_SIGNUP };

beforeEach(() => {
  process.env.CLOUD_SECRET_KEY = randomBytes(32).toString("base64");
  delete process.env.CLOUD_SIGNUP;
  resetCloudDatabase(":memory:");
  clock = START;
  setCloudClock(() => clock);
});

afterEach(() => {
  resetCloudDatabase();
  setCloudClock();
  for (const [name, value] of [
    ["CLOUD_SECRET_KEY", saved.key],
    ["CLOUD_SIGNUP", saved.signup]
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const PASSWORD = "correct horse battery";

describe("signup by invitation", () => {
  it("refuses signup without an invitation", async () => {
    const result = await signup("a@example.com", PASSWORD);
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(await signup("a@example.com", PASSWORD, "cinv_" + "0".repeat(32))).toMatchObject({ ok: false, status: 403 });
  });

  it("creates one account per invitation, then the invitation is gone", async () => {
    const invite = createInvite("admin", "Lena at Harbor Hotel");
    expect(invite.code).toMatch(/^cinv_[0-9a-f]{32}$/);
    expect(listInvites().map((item) => item.note)).toEqual(["Lena at Harbor Hotel"]);
    expect(await signup("lena@example.com", PASSWORD, invite.code)).toMatchObject({ ok: true });
    expect(await signup("someone@example.com", PASSWORD, invite.code)).toMatchObject({ ok: false, status: 403 });
    expect(listInvites()).toEqual([]);
    // Logging in needs no invitation.
    expect(await login("lena@example.com", PASSWORD)).toMatchObject({ ok: true });
  });

  it("keeps the invitation when the email is already taken", async () => {
    const first = createInvite("admin", "");
    expect(await signup("dup@example.com", PASSWORD, first.code)).toMatchObject({ ok: true });
    const second = createInvite("admin", "");
    expect(await signup("dup@example.com", PASSWORD, second.code)).toMatchObject({ ok: false, status: 409 });
    expect(listInvites().map((item) => item.code)).toEqual([second.code]);
  });

  it("expires invitations after 7 days and lets admins revoke them", async () => {
    const old = createInvite("admin", "");
    clock += 7 * 86_400_000;
    expect(await signup("late@example.com", PASSWORD, old.code)).toMatchObject({ ok: false, status: 403 });
    const fresh = createInvite("admin", "");
    expect(revokeInvite(fresh.code)).toBe(true);
    expect(revokeInvite(fresh.code)).toBe(false);
    expect(await signup("revoked@example.com", PASSWORD, fresh.code)).toMatchObject({ ok: false, status: 403 });
  });

  it("can be opened to everyone with CLOUD_SIGNUP=open", async () => {
    process.env.CLOUD_SIGNUP = "open";
    expect(await signup("open@example.com", PASSWORD)).toMatchObject({ ok: true });
  });
});

describe("console signup form", () => {
  it("reads the invitation from the link", () => {
    const code = `cinv_${"a".repeat(32)}`;
    expect(inviteFromLocation(`?invite=${code}`)).toBe(code);
    expect(inviteFromLocation("?invite=garbage")).toBe("");
    expect(inviteFromLocation("")).toBe("");
  });

  it("opens on Create account with the invitation filled in, else on Log in", () => {
    const render = (invite?: string) =>
      renderToStaticMarkup(
        createElement(
          LanguageProvider,
          null,
          createElement(AuthCard, { api: {} as never, onSignedIn: () => {}, invite })
        )
      );
    const invited = render(`cinv_${"b".repeat(32)}`);
    expect(invited).toContain(`value="cinv_${"b".repeat(32)}"`);
    expect(invited).toMatch(/aria-selected="true"[^>]*>[^<]*(创建账户|Create account)/);
    const plain = render();
    expect(plain).not.toContain("cinv_b");
    expect(plain).toMatch(/aria-selected="true"[^>]*>[^<]*(登录|Log in)/);
  });
});
