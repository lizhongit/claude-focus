import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  chromeExpiresToDate,
  decryptChromiumValue,
  decryptLoginCookies,
  encryptChromiumValue,
  readCookieMeta,
  sessionCookieExpiry,
} from "../src/desktop/cookies.ts";
import { DesktopError } from "../src/desktop/errors.ts";
import { PASSWORD, writeCookieDb } from "./support/desktop-fixture.ts";

test("解密去掉 32 字节前缀，错误密码不带出原文", () => {
  const encrypted = encryptChromiumValue(Buffer.from("sk-ant-test-a"), PASSWORD);
  const plain = decryptChromiumValue(encrypted, PASSWORD);
  assert.equal(plain.toString("utf8"), "sk-ant-test-a");
  assert.throws(
    () => decryptChromiumValue(encrypted, "other-password"),
    (error: unknown) => {
      assert.ok(error instanceof DesktopError);
      assert.equal(error.message.includes("sk-ant"), false);
      assert.equal(error.message.includes(PASSWORD), false);
      return true;
    },
  );
});

test("Chrome 到期时间按 1601 纪元换算", () => {
  const expires = new Date("2026-11-16T03:33:00.000Z");
  const chrome =
    BigInt(expires.getTime()) * 1000n + 11_644_473_600_000_000n;
  assert.equal(chromeExpiresToDate(chrome)?.toISOString(), expires.toISOString());
  assert.equal(chromeExpiresToDate(0n), null);
});

test("sessionKey 优先 .claude.ai，并且不解密也能看到到期时间", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cfocus-cookies-"));
  const file = path.join(root, "Cookies");
  await writeCookieDb(file, PASSWORD, [
    {
      name: "sessionKey",
      host: "evil.example",
      value: "sk-ant-later",
      expires: new Date("2027-01-01T00:00:00.000Z"),
    },
    {
      name: "sessionKey",
      host: ".claude.ai",
      value: "sk-ant-test-a",
      expires: new Date("2026-11-16T03:33:00.000Z"),
    },
  ]);
  const expiry = sessionCookieExpiry(await readCookieMeta(file));
  assert.equal(expiry?.expiresAt?.toISOString(), "2026-11-16T03:33:00.000Z");
  const login = decryptLoginCookies(file, PASSWORD);
  assert.equal(login.sessionKey, "sk-ant-test-a");
});
