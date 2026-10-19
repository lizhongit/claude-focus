import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isUuid } from "../config.ts";
import { text as tr } from "../i18n.ts";
import { DesktopError } from "./errors.ts";
import { isPlanId, type PlanId } from "./plan.ts";

export interface AccountRecord {
  email: string;
  organizationUuid: string | null;
  adoptedAt: string;
  plan: PlanId | null;
}

export interface FocusState {
  version: 1;
  currentAccountUuid: string | null;
  pendingPreviousUuid: string | null;
  accounts: Record<string, AccountRecord>;
}

export function emptyState(): FocusState {
  return {
    version: 1,
    currentAccountUuid: null,
    pendingPreviousUuid: null,
    accounts: {},
  };
}

function readAccount(value: unknown): AccountRecord {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new DesktopError(tr("Account record in state.json has the wrong shape", "state.json 里的账号记录格式不对"));
  }
  const row = value as Record<string, unknown>;
  const email = typeof row.email === "string" ? row.email.trim() : "";
  if (email !== "" && !email.includes("@")) {
    throw new DesktopError(tr("Email in state.json is invalid", "state.json 里的邮箱格式不对"));
  }
  const organizationUuid =
    typeof row.organizationUuid === "string" && isUuid(row.organizationUuid)
      ? row.organizationUuid
      : null;
  const adoptedAt =
    typeof row.adoptedAt === "string" && row.adoptedAt.length > 0
      ? row.adoptedAt
      : new Date(0).toISOString();
  const plan = typeof row.plan === "string" && isPlanId(row.plan) ? row.plan : null;
  return { email, organizationUuid, adoptedAt, plan };
}

export function parseState(raw: unknown): FocusState {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DesktopError(tr("state.json must be a JSON object", "state.json 必须是 JSON 对象"));
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) {
    throw new DesktopError(tr("state.json version is not recognized", "state.json 版本无法识别"));
  }
  const current =
    typeof record.currentAccountUuid === "string"
      ? record.currentAccountUuid
      : null;
  const pending =
    typeof record.pendingPreviousUuid === "string"
      ? record.pendingPreviousUuid
      : null;
  if (current != null && !isUuid(current)) {
    throw new DesktopError(tr("Current account in state.json is not a UUID", "state.json 里的当前账号不是 UUID"));
  }
  if (pending != null && !isUuid(pending)) {
    throw new DesktopError(tr("Pending account in state.json is not a UUID", "state.json 里的待恢复账号不是 UUID"));
  }
  if (
    record.accounts == null ||
    typeof record.accounts !== "object" ||
    Array.isArray(record.accounts)
  ) {
    throw new DesktopError(tr("state.json is missing accounts", "state.json 缺少 accounts"));
  }
  const accounts: Record<string, AccountRecord> = {};
  for (const [uuid, value] of Object.entries(record.accounts)) {
    if (!isUuid(uuid)) throw new DesktopError(tr("state.json contains an invalid account UUID", "state.json 里有非法账号 UUID"));
    accounts[uuid] = readAccount(value);
  }
  return {
    version: 1,
    currentAccountUuid: current,
    pendingPreviousUuid: pending,
    accounts,
  };
}

export async function loadState(statePath: string): Promise<FocusState | null> {
  let text: string;
  try {
    text = await readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new DesktopError(tr(`state.json is not valid JSON: ${statePath}`, `state.json 不是合法 JSON：${statePath}`));
  }
  return parseState(raw);
}

export async function saveState(
  statePath: string,
  state: FocusState,
): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(statePath, 0o600);
}

export function accountByUuid(
  state: FocusState,
  accountUuid: string,
): { uuid: string; account: AccountRecord } | null {
  const key = accountUuid.toLowerCase();
  for (const [uuid, account] of Object.entries(state.accounts)) {
    if (uuid.toLowerCase() === key) return { uuid, account };
  }
  return null;
}

export function accountByEmail(
  state: FocusState,
  email: string,
): { uuid: string; account: AccountRecord } | null {
  const key = email.trim().toLowerCase();
  if (key === "" || !key.includes("@")) return null;
  for (const [uuid, account] of Object.entries(state.accounts)) {
    if (account.email.toLowerCase() === key) return { uuid, account };
  }
  return null;
}

export function dataDirForAccount(
  claudeDataDir: string,
  profilesDir: string,
  state: FocusState,
  accountUuid: string,
): string {
  if (state.currentAccountUuid?.toLowerCase() === accountUuid.toLowerCase()) {
    return claudeDataDir;
  }
  const found = accountByUuid(state, accountUuid);
  return path.join(profilesDir, found?.uuid ?? accountUuid);
}
