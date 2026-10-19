import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encryptChromiumValue } from "../../src/desktop/cookies.ts";
import { focusPaths, type FocusPaths } from "../../src/desktop/paths.ts";
import type { DesktopRuntime } from "../../src/desktop/commands.ts";
import type { FetchLike } from "../../src/desktop/usage.ts";

const CHROME_EPOCH_OFFSET_US = 11_644_473_600_000_000n;

export const UUID_A = "71f17eac-25e9-48b9-8b63-c05b22c21f86";
export const UUID_B = "bcb99ed5-923e-43f6-ba7f-6a68eaef9447";
export const ORG_A = "414b5c5d-9cbb-4754-8647-e0b967072423";
export const ORG_B = "ca0ad706-6476-46fd-bc9f-a252f22e041a";
export const PASSWORD = "test-password";

export function chromeExpires(date: Date): bigint {
  return BigInt(date.getTime()) * 1000n + CHROME_EPOCH_OFFSET_US;
}

export async function writeCookieDb(
  file: string,
  password: string,
  cookies: { name: string; host: string; value: string; expires: Date }[],
): Promise<void> {
  const db = new DatabaseSync(file);
  db.exec(
    `CREATE TABLE cookies (
      name TEXT,
      host_key TEXT,
      encrypted_value BLOB,
      expires_utc INTEGER
    )`,
  );
  const insert = db.prepare(
    "INSERT INTO cookies (name, host_key, encrypted_value, expires_utc) VALUES (?, ?, ?, ?)",
  );
  for (const cookie of cookies) {
    insert.run(
      cookie.name,
      cookie.host,
      encryptChromiumValue(Buffer.from(cookie.value), password),
      chromeExpires(cookie.expires),
    );
  }
  db.close();
}

export function jsonResponse(body: unknown, status = 200): {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

export async function tempDesktop(): Promise<{ root: string; paths: FocusPaths }> {
  const root = await mkdtemp(path.join(tmpdir(), "cfocus-desktop-"));
  const paths = focusPaths({
    claudeDataDir: path.join(root, "Claude"),
    focusRoot: path.join(root, "cfocus"),
  });
  return { root, paths };
}

export interface FakeDesktop {
  runtime: DesktopRuntime;
  logs: string[];
  quits: { count: number };
  launches: { count: number };
  passwordReads: { count: number };
  now: { value: number };
  running: { value: boolean };
}

export function fakeDesktop(options: {
  root: string;
  paths: FocusPaths;
  fetchImpl: FetchLike;
  yes?: boolean;
  tty?: boolean;
}): FakeDesktop {
  const logs: string[] = [];
  const quits = { count: 0 };
  const launches = { count: 0 };
  const passwordReads = { count: 0 };
  const now = { value: 1_700_000_000_000 };
  const running = { value: false };
  const runtime: DesktopRuntime = {
    paths: options.paths,
    configPath: path.join(options.root, "accounts.json"),
    claudeJsonPath: path.join(options.root, ".claude.json"),
    yes: options.yes ?? true,
    isTTY: options.tty ?? false,
    quitTimeoutMs: 50,
    loginTimeoutMs: 10_000,
    pollIntervalMs: 1_000,
    quit: async () => {
      quits.count += 1;
      running.value = false;
    },
    launch: async () => {
      launches.count += 1;
      running.value = true;
    },
    isRunning: () => running.value,
    sleep: async (ms) => {
      now.value += ms;
    },
    now: () => now.value,
    readPassword: async () => {
      passwordReads.count += 1;
      return PASSWORD;
    },
    fetch: options.fetchImpl,
    confirm: async () => {
      throw new Error("测试里不应再询问");
    },
    log: (message) => logs.push(message),
  };
  return { runtime, logs, quits, launches, passwordReads, now, running };
}

export async function seedLiveAccount(liveDir: string): Promise<void> {
  await mkdir(path.join(liveDir, "Cache"), { recursive: true });
  await writeFile(path.join(liveDir, "Cache", "keep.bin"), "cache-body");
  await writeFile(path.join(liveDir, "who.txt"), "a");
  await writeFile(
    path.join(liveDir, "config.json"),
    JSON.stringify({
      lastKnownAccountUuid: UUID_A,
      "oauth:tokenCache": "djEwSECRET",
    }),
  );
  await mkdir(path.join(liveDir, "claude-code-sessions", UUID_A, ORG_A), {
    recursive: true,
  });
  await writeCookieDb(path.join(liveDir, "Cookies"), PASSWORD, [
    {
      name: "sessionKey",
      host: ".claude.ai",
      value: "sk-ant-test-a",
      expires: new Date("2026-11-16T03:33:00.000Z"),
    },
    {
      name: "cf_clearance",
      host: ".claude.ai",
      value: "clearance-a",
      expires: new Date("2026-10-19T08:00:00.000Z"),
    },
    {
      name: "lastActiveOrg",
      host: "claude.ai",
      value: ORG_A,
      expires: new Date("2026-12-21T00:00:00.000Z"),
    },
  ]);
}
