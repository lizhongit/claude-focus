import { readFile } from "node:fs/promises";
import { isUuid } from "../config.ts";
import { text as tr } from "../i18n.ts";
import { DesktopError } from "./errors.ts";

export async function readLastKnownAccountUuid(
  configPath: string,
): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new DesktopError(tr("Claude config.json is not valid JSON", "Claude 的 config.json 不是合法 JSON"));
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>).lastKnownAccountUuid;
  if (typeof value !== "string" || !isUuid(value)) return null;
  return value;
}

export async function waitForAccountUuid(options: {
  configPath: string;
  blockedUuid: string | null;
  timeoutMs: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}): Promise<string | null> {
  const started = options.now();
  for (;;) {
    const uuid = await readLastKnownAccountUuid(options.configPath);
    if (
      uuid != null &&
      uuid.toLowerCase() !== options.blockedUuid?.toLowerCase()
    ) {
      return uuid;
    }
    if (options.now() - started >= options.timeoutMs) return null;
    const before = options.now();
    await options.sleep(options.intervalMs);
    if (options.now() <= before) {
      throw new DesktopError(tr("The clock did not advance while waiting for login", "等待登录时时钟没有前进"));
    }
  }
}
