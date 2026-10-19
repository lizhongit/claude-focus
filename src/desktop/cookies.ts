import { createCipheriv, createDecipheriv, pbkdf2Sync } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { text } from "../i18n.ts";
import { DesktopError } from "./errors.ts";

const require = createRequire(import.meta.url);
let DatabaseSyncCtor: typeof DatabaseSync | undefined;

function loadDatabaseSync(): typeof DatabaseSync {
  if (DatabaseSyncCtor != null) return DatabaseSyncCtor;
  const original = process.emitWarning;
  process.emitWarning = (warning, ...rest: unknown[]) => {
    const message =
      typeof warning === "string"
        ? warning
        : warning instanceof Error
          ? warning.message
          : "";
    if (message.includes("SQLite is an experimental feature")) return;
    return Reflect.apply(original, process, [warning, ...rest]);
  };
  try {
    const sqlite = require("node:sqlite") as typeof import("node:sqlite");
    DatabaseSyncCtor = sqlite.DatabaseSync;
  } finally {
    process.emitWarning = original;
  }
  return DatabaseSyncCtor;
}

const SALT = "saltysalt";
const ITERATIONS = 1003;
const KEY_BYTES = 16;
const IV = Buffer.alloc(16, " ");
const V10 = Buffer.from("v10");
const PLAINTEXT_PREFIX_BYTES = 32;
const CHROME_EPOCH_OFFSET_US = 11_644_473_600_000_000n;

const HOST_RANK: Record<string, number> = {
  ".claude.ai": 0,
  "claude.ai": 1,
};

export interface CookieMeta {
  name: string;
  host: string;
  expiresAt: Date | null;
}

interface CookieRow {
  name: string;
  host: string;
  expiresAt: Date | null;
  encrypted: Buffer | null;
}

function deriveKey(password: string): Buffer {
  return pbkdf2Sync(password, SALT, ITERATIONS, KEY_BYTES, "sha1");
}

/** 测试用。明文前有 32 字节前缀，和 Chromium 解出来的布局一致。 */
export function encryptChromiumValue(value: Buffer, password: string): Buffer {
  const plain = Buffer.concat([Buffer.alloc(PLAINTEXT_PREFIX_BYTES, 1), value]);
  const cipher = createCipheriv("aes-128-cbc", deriveKey(password), IV);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([V10, body]);
}

export function decryptChromiumValue(encrypted: Buffer, password: string): Buffer {
  if (encrypted.length < 3 || !encrypted.subarray(0, 3).equals(V10)) {
    throw new DesktopError(text("Cookie is not v10 and was not decrypted", "cookie 不是 v10，没有解密"));
  }
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", deriveKey(password), IV);
    plain = Buffer.concat([
      decipher.update(encrypted.subarray(3)),
      decipher.final(),
    ]);
  } catch {
    throw new DesktopError(text("Cookie decryption failed", "cookie 解密失败"));
  }
  if (plain.length < PLAINTEXT_PREFIX_BYTES) {
    throw new DesktopError(text("Decrypted cookie is too short", "cookie 解密结果太短"));
  }
  return plain.subarray(PLAINTEXT_PREFIX_BYTES);
}

export function chromeExpiresToDate(expiresUtc: bigint): Date | null {
  if (expiresUtc <= 0n) return null;
  const unixUs = expiresUtc - CHROME_EPOCH_OFFSET_US;
  const unixMs = unixUs / 1000n;
  const date = new Date(Number(unixMs));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function asBigInt(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function hostRank(host: string): number {
  return HOST_RANK[host] ?? (host.endsWith("claude.ai") ? 2 : 3);
}

function pickRows(rows: CookieRow[], name: string): CookieRow | null {
  const matches = rows.filter((row) => row.name === name);
  matches.sort((left, right) => {
    const rank = hostRank(left.host) - hostRank(right.host);
    if (rank !== 0) return rank;
    const leftMs = left.expiresAt?.getTime() ?? 0;
    const rightMs = right.expiresAt?.getTime() ?? 0;
    return rightMs - leftMs;
  });
  return matches[0] ?? null;
}

function readRows(cookiePath: string): CookieRow[] {
  let db: DatabaseSync;
  try {
    db = new (loadDatabaseSync())(cookiePath, { readOnly: true });
  } catch {
    throw new DesktopError(
      text(
        "Could not read Cookies. If Claude Desktop is open, quit it completely and try again.",
        "读不到 Cookies。如果 Claude Desktop 正打开着，先完全退出再查。",
      ),
    );
  }
  try {
    const statement = db.prepare(
      `SELECT name, host_key, CAST(expires_utc AS TEXT) AS expires_utc, encrypted_value
       FROM cookies`,
    );
    const result: CookieRow[] = [];
    for (const row of statement.all()) {
      if (row == null || typeof row !== "object" || Array.isArray(row)) continue;
      const record = row as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : "";
      const host = typeof record.host_key === "string" ? record.host_key : "";
      if (name === "" || host === "") continue;
      const expiresRaw =
        typeof record.expires_utc === "string" ? asBigInt(record.expires_utc) : null;
      const encryptedValue = record.encrypted_value;
      const encrypted =
        encryptedValue instanceof Uint8Array && encryptedValue.byteLength > 0
          ? Buffer.from(encryptedValue)
          : null;
      result.push({
        name,
        host,
        expiresAt: expiresRaw == null ? null : chromeExpiresToDate(expiresRaw),
        encrypted,
      });
    }
    return result;
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    throw new DesktopError(text("Cookies has no usable rows", "Cookies 里没有可用的记录"));
  } finally {
    db.close();
  }
}

export function sessionCookieExpiry(rows: CookieMeta[]): {
  name: string;
  expiresAt: Date | null;
} | null {
  const ranked = (name: string): CookieMeta | null => {
    const matches = rows.filter((row) => row.name === name);
    matches.sort((left, right) => {
      const rank = hostRank(left.host) - hostRank(right.host);
      if (rank !== 0) return rank;
      return (right.expiresAt?.getTime() ?? 0) - (left.expiresAt?.getTime() ?? 0);
    });
    return matches[0] ?? null;
  };
  const chosen = ranked("sessionKey") ?? ranked("sessionKeyV3");
  if (chosen == null) return null;
  return { name: chosen.name, expiresAt: chosen.expiresAt };
}

export async function readCookieMeta(cookiePath: string): Promise<CookieMeta[]> {
  return readRows(cookiePath).map((row) => ({
    name: row.name,
    host: row.host,
    expiresAt: row.expiresAt,
  }));
}

export interface DecryptedLoginCookies {
  sessionKey: string;
  cfClearance: string | null;
  lastActiveOrg: string | null;
}

export function decryptLoginCookies(
  cookiePath: string,
  password: string,
): DecryptedLoginCookies {
  const rows = readRows(cookiePath);
  const session = pickRows(rows, "sessionKey");
  if (session?.encrypted == null) {
    throw new DesktopError(text("Cookies has no sessionKey", "Cookies 里没有 sessionKey"));
  }
  const sessionKey = decryptChromiumValue(session.encrypted, password).toString(
    "utf8",
  );
  if (sessionKey === "") throw new DesktopError(text("sessionKey is empty", "sessionKey 是空的"));
  const clearance = pickRows(rows, "cf_clearance");
  const org = pickRows(rows, "lastActiveOrg");
  const cfClearance =
    clearance?.encrypted == null
      ? null
      : decryptChromiumValue(clearance.encrypted, password).toString("utf8");
  const lastActiveOrg =
    org?.encrypted == null
      ? null
      : decryptChromiumValue(org.encrypted, password).toString("utf8");
  return {
    sessionKey,
    cfClearance: cfClearance === "" ? null : cfClearance,
    lastActiveOrg: lastActiveOrg === "" ? null : lastActiveOrg,
  };
}
