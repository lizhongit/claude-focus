import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { listJoin, text as tr } from "./i18n.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export interface AccountConfig {
  email: string;
  accountUuid: string;
}

export interface AppConfig {
  sessionsRoot: string;
  accounts: AccountConfig[];
}

export function defaultConfigPath(): string {
  return path.join(homedir(), ".config", "claude-focus", "accounts.json");
}

export function defaultSessionsRoot(): string {
  return path.join(
    homedir(),
    "Library/Application Support/Claude/claude-code-sessions",
  );
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parseConfig(raw: unknown, fallbackRoot: string): AppConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(tr("Config must be a JSON object", "配置文件必须是 JSON 对象"));
  }
  const record = raw as Record<string, unknown>;
  const sessionsRoot =
    typeof record.sessionsRoot === "string" && record.sessionsRoot.length > 0
      ? record.sessionsRoot
      : fallbackRoot;
  if (!Array.isArray(record.accounts)) {
    throw new ConfigError(tr("Config is missing the accounts array", "配置缺少 accounts 数组"));
  }
  const accounts: AccountConfig[] = [];
  const emails = new Set<string>();
  const uuids = new Set<string>();
  for (const item of record.accounts) {
    if (item == null || typeof item !== "object" || Array.isArray(item)) {
      throw new ConfigError(
        tr(
          "Each account needs email and accountUuid",
          "accounts 里的每一项都要有 email 和 accountUuid",
        ),
      );
    }
    const row = item as Record<string, unknown>;
    const email = typeof row.email === "string" ? row.email.trim() : "";
    const accountUuid =
      typeof row.accountUuid === "string" ? row.accountUuid.trim() : "";
    if (!UUID_RE.test(accountUuid)) {
      throw new ConfigError(
        tr(
          `accountUuid is not a UUID: ${accountUuid || "(empty)"}`,
          `accountUuid 不是 UUID：${accountUuid || "(空)"}`,
        ),
      );
    }
    if (email !== "" && !email.includes("@")) {
      throw new ConfigError(tr(`Invalid email: ${email}`, `邮箱格式不对：${email}`));
    }
    const emailKey = email.toLowerCase();
    if (emailKey !== "" && emails.has(emailKey)) {
      throw new ConfigError(tr(`Duplicate email: ${email}`, `邮箱重复：${email}`));
    }
    const uuidKey = accountUuid.toLowerCase();
    if (uuids.has(uuidKey)) {
      throw new ConfigError(tr(`Duplicate account UUID: ${accountUuid}`, `账号 UUID 重复：${accountUuid}`));
    }
    if (emailKey !== "") emails.add(emailKey);
    uuids.add(uuidKey);
    accounts.push({ email, accountUuid });
  }
  return { sessionsRoot, accounts };
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ConfigError(
        tr(
          `No config file yet. Run: cfocus init\nExpected path: ${configPath}`,
          `还没有配置文件。先运行：cfocus init\n预期路径：${configPath}`,
        ),
      );
    }
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new ConfigError(tr(`Config is not valid JSON: ${configPath}`, `配置不是合法 JSON：${configPath}`));
  }
  return parseConfig(raw, defaultSessionsRoot());
}

export function accountByEmail(
  config: AppConfig,
  email: string,
): AccountConfig {
  const key = email.trim().toLowerCase();
  const found = config.accounts.find(
    (account) => account.email.toLowerCase() === key,
  );
  if (!found || found.email === "") {
    const known = config.accounts
      .filter((account) => account.email !== "")
      .map((account) => account.email);
    const hint =
      known.length > 0
        ? tr(`Configured: ${listJoin(known)}`, `已配置：${listJoin(known)}`)
        : tr("No usable email is configured", "配置里还没有可用邮箱");
    throw new ConfigError(tr(`No account for ${email}. ${hint}`, `找不到邮箱 ${email}。${hint}`));
  }
  return found;
}

export function usableAccounts(config: AppConfig): AccountConfig[] {
  return config.accounts.filter((account) => account.email !== "");
}

interface OauthIdentity {
  email: string;
  accountUuid: string;
}

export async function readCliOauthIdentity(
  claudeJsonPath: string,
): Promise<OauthIdentity | null> {
  let text: string;
  try {
    text = await readFile(claudeJsonPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const oauth = (raw as Record<string, unknown>).oauthAccount;
  if (oauth == null || typeof oauth !== "object" || Array.isArray(oauth)) {
    return null;
  }
  const record = oauth as Record<string, unknown>;
  const email = record.emailAddress;
  const accountUuid = record.accountUuid;
  if (typeof email !== "string" || typeof accountUuid !== "string") return null;
  if (!email.includes("@") || !UUID_RE.test(accountUuid)) return null;
  return { email, accountUuid };
}

export async function discoverAccountUuids(
  sessionsRoot: string,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && UUID_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export async function createInitialConfig(options: {
  configPath: string;
  sessionsRoot: string;
  claudeJsonPath: string;
}): Promise<AppConfig> {
  const uuids = await discoverAccountUuids(options.sessionsRoot);
  const identity = await readCliOauthIdentity(options.claudeJsonPath);
  const accounts: AccountConfig[] = uuids.map((accountUuid) => ({
    email:
      identity &&
      identity.accountUuid.toLowerCase() === accountUuid.toLowerCase()
        ? identity.email
        : "",
    accountUuid,
  }));
  const config: AppConfig = {
    sessionsRoot: options.sessionsRoot,
    accounts,
  };
  await mkdir(path.dirname(options.configPath), { recursive: true });
  await writeFile(
    options.configPath,
    `${JSON.stringify(config, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return config;
}

export type UpsertResult =
  | { status: "unchanged" }
  | { status: "saved" }
  | { status: "email-taken" };

/** 把 Desktop 识别到的邮箱写进会话索引配置。已有不同邮箱时不覆盖。 */
export async function upsertKnownAccount(options: {
  configPath: string;
  sessionsRoot: string;
  accountUuid: string;
  email: string;
}): Promise<UpsertResult> {
  if (!isUuid(options.accountUuid)) {
    throw new ConfigError(
      tr(
        `accountUuid is not a UUID: ${options.accountUuid}`,
        `accountUuid 不是 UUID：${options.accountUuid}`,
      ),
    );
  }
  const email = options.email.trim();
  if (email !== "" && !email.includes("@")) {
    throw new ConfigError(tr(`Invalid email: ${email}`, `邮箱格式不对：${email}`));
  }
  let config: AppConfig = {
    sessionsRoot: options.sessionsRoot,
    accounts: [],
  };
  let existed = false;
  try {
    const text = await readFile(options.configPath, "utf8");
    existed = true;
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      throw new ConfigError(
        tr(
          `Config is not valid JSON: ${options.configPath}`,
          `配置不是合法 JSON：${options.configPath}`,
        ),
      );
    }
    config = parseConfig(raw, options.sessionsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const uuidKey = options.accountUuid.toLowerCase();
  const emailKey = email.toLowerCase();
  const emailOwner = config.accounts.find(
    (account) => account.email !== "" && account.email.toLowerCase() === emailKey,
  );
  const emailTaken =
    emailKey !== "" &&
    emailOwner != null &&
    emailOwner.accountUuid.toLowerCase() !== uuidKey;
  const current = config.accounts.find(
    (account) => account.accountUuid.toLowerCase() === uuidKey,
  );
  if (emailTaken) {
    if (current == null) {
      config.accounts.push({ email: "", accountUuid: options.accountUuid });
    }
  } else if (current == null) {
    config.accounts.push({ email, accountUuid: options.accountUuid });
  } else if (email !== "" && current.email === "") {
    current.email = email;
  } else if (email !== "" && current.email.toLowerCase() !== emailKey) {
    return { status: "email-taken" };
  } else {
    return { status: "unchanged" };
  }
  await mkdir(path.dirname(options.configPath), { recursive: true });
  await writeFile(options.configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(options.configPath, 0o600);
  if (!existed || current == null || (current.email === "" && email !== "" && !emailTaken)) {
    return emailTaken ? { status: "email-taken" } : { status: "saved" };
  }
  return emailTaken ? { status: "email-taken" } : { status: "saved" };
}
