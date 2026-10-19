import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  readCliOauthIdentity,
  upsertKnownAccount,
} from "../config.ts";
import {
  formatShanghai,
  renderAccountTable,
  type AccountListRow,
  type AccountUsageCells,
} from "../format.ts";
import {
  chooseOrg,
  findSession,
  listOrgCandidates,
  normalizeSessionId,
  readSessions,
  type SessionMeta,
} from "../sessions.ts";
import { listJoin, text } from "../i18n.ts";
import { applyCopies, planCopies, type CopyPlan } from "../sync.ts";
import { waitUntilStopped } from "./control.ts";
import { readCookieMeta, sessionCookieExpiry } from "./cookies.ts";
import { DesktopError } from "./errors.ts";
import { readLastKnownAccountUuid, waitForAccountUuid } from "./identity.ts";
import {
  backupLiveIfMissing,
  createBlankLive,
  ensureShared,
  parkLiveProfile,
  removeDirectoryKeepingLinkTargets,
  restoreParkedProfile,
  swapLiveProfile,
} from "./layout.ts";
import {
  cookieDbPath,
  desktopConfigPath,
  type FocusPaths,
} from "./paths.ts";
import { type PlanId } from "./plan.ts";
import {
  accountByEmail,
  accountByUuid,
  dataDirForAccount,
  emptyState,
  loadState,
  saveState,
  type AccountRecord,
  type FocusState,
} from "./state.ts";
import {
  readAccountSnapshot,
  type FetchLike,
  type UsageSummary,
  type UsageWindow,
} from "./usage.ts";

export interface DesktopRuntime {
  paths: FocusPaths;
  configPath: string;
  claudeJsonPath: string;
  yes: boolean;
  isTTY: boolean;
  quitTimeoutMs: number;
  loginTimeoutMs: number;
  pollIntervalMs: number;
  quit: () => Promise<void>;
  launch: () => Promise<void>;
  isRunning: () => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  readPassword: () => Promise<string>;
  fetch: FetchLike;
  confirm: (message: string) => Promise<boolean>;
  log: (message: string) => void;
  color?: boolean;
  columns?: number;
}

export interface SwitchOptions {
  toEmail: string;
  sessionIds: string[];
  overwrite: boolean;
  sourceOrg?: string;
  destOrg?: string;
}

async function confirmed(runtime: DesktopRuntime, message: string): Promise<void> {
  if (runtime.yes) return;
  if (!runtime.isTTY) {
    throw new DesktopError(
      `${message}\n${text("Add --yes when there is no terminal prompt.", "非交互环境要加 --yes")}`,
    );
  }
  const accepted = await runtime.confirm(message);
  if (!accepted) throw new DesktopError(text("Cancelled.", "已取消"));
}

async function openDesktop(runtime: DesktopRuntime): Promise<void> {
  try {
    await runtime.launch();
  } catch (error) {
    runtime.log(
      error instanceof Error
        ? error.message
        : text("Could not open Claude Desktop.", "没能打开 Claude Desktop"),
    );
  }
}

async function withDesktopStopped<T>(
  runtime: DesktopRuntime,
  action: () => Promise<T>,
): Promise<T> {
  const wasRunning = runtime.isRunning();
  if (wasRunning) {
    await runtime.quit();
    const stopped = await waitUntilStopped({
      isRunning: runtime.isRunning,
      timeoutMs: runtime.quitTimeoutMs,
      intervalMs: 200,
      sleep: runtime.sleep,
    });
    if (!stopped || runtime.isRunning()) {
      throw new DesktopError(
        text(
          "Claude Desktop did not quit. No files were moved.",
          "Claude Desktop 没有退出。没有移动任何文件。",
        ),
      );
    }
  }
  try {
    return await action();
  } catch (error) {
    if (wasRunning) {
      try {
        await runtime.launch();
      } catch {
        runtime.log(text("Could not reopen Claude Desktop.", "没能重新打开 Claude Desktop。"));
      }
    }
    throw error;
  }
}

async function requireState(runtime: DesktopRuntime): Promise<FocusState> {
  const state = await loadState(runtime.paths.statePath);
  if (state == null) {
    throw new DesktopError(
      text(
        "No Desktop account yet. Run cfocus account init first.",
        "还没有 Desktop 账号。先运行 cfocus account init。",
      ),
    );
  }
  return state;
}

function sessionsRootOf(runtime: DesktopRuntime): string {
  return path.join(runtime.paths.claudeDataDir, "claude-code-sessions");
}

async function discoverOrganization(
  runtime: DesktopRuntime,
  accountUuid: string,
): Promise<string | null> {
  const orgs = await listOrgCandidates(
    path.join(sessionsRootOf(runtime), accountUuid),
  );
  const choice = chooseOrg(orgs);
  return choice.ok ? choice.org.orgUuid : null;
}

async function emailFromAccountsFile(
  configPath: string,
  accountUuid: string,
): Promise<string> {
  try {
    const text = await readFile(configPath, "utf8");
    const raw = JSON.parse(text) as unknown;
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return "";
    const accounts = (raw as Record<string, unknown>).accounts;
    if (!Array.isArray(accounts)) return "";
    for (const item of accounts) {
      if (item == null || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      if (
        typeof row.accountUuid === "string" &&
        row.accountUuid.toLowerCase() === accountUuid.toLowerCase() &&
        typeof row.email === "string" &&
        row.email.includes("@")
      ) {
        return row.email.trim();
      }
    }
  } catch {
    return "";
  }
  return "";
}

async function rememberAccount(
  runtime: DesktopRuntime,
  accountUuid: string,
  email: string,
): Promise<void> {
  const result = await upsertKnownAccount({
    configPath: runtime.configPath,
    sessionsRoot: sessionsRootOf(runtime),
    accountUuid,
    email,
  });
  if (result.status === "email-taken" && email !== "") {
    runtime.log(
      text(
        `Email ${email} belongs to another account in the session map. It was not overwritten.`,
        `邮箱 ${email} 在会话配置里属于另一个账号，没有覆盖。`,
      ),
    );
  }
}

function putAccount(
  state: FocusState,
  accountUuid: string,
  record: AccountRecord,
): void {
  if (record.email !== "") {
    const owner = accountByEmail(state, record.email);
    if (owner && owner.uuid.toLowerCase() !== accountUuid.toLowerCase()) {
      throw new DesktopError(
        text(
          `Email ${record.email} already belongs to another account`,
          `邮箱 ${record.email} 已经属于另一个账号`,
        ),
      );
    }
  }
  const existing = accountByUuid(state, accountUuid);
  if (existing) {
    state.accounts[existing.uuid] = {
      email: record.email !== "" ? record.email : existing.account.email,
      organizationUuid:
        record.organizationUuid ?? existing.account.organizationUuid,
      adoptedAt: existing.account.adoptedAt,
      plan: record.plan ?? existing.account.plan,
    };
    return;
  }
  state.accounts[accountUuid] = record;
}

async function identifyAccount(
  runtime: DesktopRuntime,
  dataDir: string,
  accountUuid: string,
  knownOrganizationUuid: string | null,
): Promise<{
  email: string;
  organizationUuid: string | null;
  usage: UsageSummary | null;
  plan: PlanId | null;
}> {
  let email = "";
  let organizationUuid = knownOrganizationUuid;
  let usage: UsageSummary | null = null;
  let plan: PlanId | null = null;
  const cookies = cookieDbPath(dataDir);
  if (existsSync(cookies)) {
    try {
      const password = await runtime.readPassword();
      const snapshot = await readAccountSnapshot({
        cookiePath: cookies,
        password,
        knownOrganizationUuid,
        fetchImpl: runtime.fetch,
      });
      if (snapshot.email) email = snapshot.email;
      if (snapshot.organizationUuid) organizationUuid = snapshot.organizationUuid;
      usage = snapshot.usage;
      plan = snapshot.plan;
    } catch (error) {
      runtime.log(
        text(
          `Could not read the email from the login: ${error instanceof Error ? error.message : "failed"}`,
          `没能从登录状态识别邮箱：${error instanceof Error ? error.message : "失败"}`,
        ),
      );
    }
  }
  if (email === "") email = await emailFromAccountsFile(runtime.configPath, accountUuid);
  if (email === "") {
    const oauth = await readCliOauthIdentity(runtime.claudeJsonPath);
    if (oauth && oauth.accountUuid.toLowerCase() === accountUuid.toLowerCase()) {
      email = oauth.email;
    }
  }
  if (organizationUuid == null) {
    organizationUuid = await discoverOrganization(runtime, accountUuid);
  }
  return { email, organizationUuid, usage, plan };
}

function formatWindow(label: string, window: UsageWindow | null): string | null {
  if (window == null) return null;
  const reset =
    window.resetsAt == null
      ? text("unknown time", "时间未知")
      : formatShanghai(Date.parse(window.resetsAt));
  return text(
    `  ${label} ${window.utilization}%, resets ${reset}`,
    `  ${label} ${window.utilization}%，重置 ${reset}`,
  );
}

function formatUsage(usage: UsageSummary): string {
  return [
    formatWindow(text("5 hours", "5 小时"), usage.fiveHour),
    formatWindow(text("7 days", "7 天"), usage.sevenDay),
    formatWindow(text("7-day Sonnet", "7 天 Sonnet"), usage.sevenDaySonnet),
  ]
    .filter((line): line is string => line != null)
    .join("\n");
}

async function readExpiry(
  dataDir: string,
  now: number,
): Promise<{ expiresAt: number | null; expired: boolean; expiryNote: string | null }> {
  const cookiePath = cookieDbPath(dataDir);
  if (!existsSync(cookiePath)) {
    return { expiresAt: null, expired: false, expiryNote: text("no Cookies", "没有 Cookies") };
  }
  try {
    const session = sessionCookieExpiry(await readCookieMeta(cookiePath));
    if (session == null) {
      return { expiresAt: null, expired: false, expiryNote: text("no sessionKey", "没有 sessionKey") };
    }
    if (session.expiresAt == null) {
      return {
        expiresAt: null,
        expired: false,
        expiryNote: text("no expiry time", "没有到期时间"),
      };
    }
    const expiresAt = session.expiresAt.getTime();
    return { expiresAt, expired: expiresAt <= now, expiryNote: null };
  } catch (error) {
    return {
      expiresAt: null,
      expired: false,
      expiryNote: error instanceof Error ? error.message : text("could not read Cookies", "读不到 Cookies"),
    };
  }
}

async function rememberSnapshot(
  runtime: DesktopRuntime,
  state: FocusState,
  accountUuid: string,
  account: AccountRecord,
  email: string,
  organizationUuid: string | null,
  plan: PlanId | null,
): Promise<void> {
  const emailLearned = account.email === "" && email !== "";
  const planLearned = plan != null && plan !== account.plan;
  if (!emailLearned && !planLearned) return;
  putAccount(state, accountUuid, {
    email,
    organizationUuid,
    adoptedAt: account.adoptedAt,
    plan,
  });
  await saveState(runtime.paths.statePath, state);
  if (emailLearned) await rememberAccount(runtime, accountUuid, email);
}

async function buildAccountRow(
  runtime: DesktopRuntime,
  state: FocusState,
  accountUuid: string,
  account: AccountRecord,
  password: string | null,
  includeUsage: boolean,
): Promise<AccountListRow> {
  const dataDir = dataDirForAccount(
    runtime.paths.claudeDataDir,
    runtime.paths.profilesDir,
    state,
    accountUuid,
  );
  const current = state.currentAccountUuid?.toLowerCase() === accountUuid.toLowerCase();
  const expiry = await readExpiry(dataDir, runtime.now());
  let email = account.email;
  let plan = account.plan;
  let note: string | null = null;
  let usage: AccountUsageCells | null = null;
  if (password && (includeUsage || plan == null)) {
    try {
      const snapshot = await readAccountSnapshot({
        cookiePath: cookieDbPath(dataDir),
        password,
        knownOrganizationUuid: account.organizationUuid,
        fetchImpl: runtime.fetch,
        includeUsage,
      });
      if (email === "" && snapshot.email) email = snapshot.email;
      if (snapshot.plan) plan = snapshot.plan;
      await rememberSnapshot(
        runtime,
        state,
        accountUuid,
        account,
        email,
        snapshot.organizationUuid ?? account.organizationUuid,
        plan,
      );
      if (includeUsage) {
        usage = {
          fiveHour: snapshot.usage?.fiveHour?.utilization ?? null,
          sevenDay: snapshot.usage?.sevenDay?.utilization ?? null,
          sevenDaySonnet: snapshot.usage?.sevenDaySonnet?.utilization ?? null,
          note:
            snapshot.usage == null
              ? text("No organization, so usage is unavailable.", "没有组织，查不到额度")
              : null,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : text("query failed", "查询失败");
      if (includeUsage) {
        usage = {
          fiveHour: null,
          sevenDay: null,
          sevenDaySonnet: null,
          note: message,
        };
      } else {
        note = message;
      }
    }
  }
  return {
    current,
    email,
    accountUuid,
    organizationUuid: account.organizationUuid,
    plan,
    ...expiry,
    note,
    usage,
  };
}

function logAccountTable(runtime: DesktopRuntime, rows: AccountListRow[]): void {
  runtime.log(
    renderAccountTable({
      rows,
      color: runtime.color === true,
      ...(runtime.columns != null ? { columns: runtime.columns } : {}),
    }),
  );
}

function orgError(role: string, reason: "none" | "ambiguous"): string {
  if (reason === "none") {
    return text(`${role} has no organization directory`, `${role}下面没有组织目录`);
  }
  return text(
    `${role} has more than one organization with sessions. Pass --source-org or --dest-org.`,
    `${role}有多个含会话的组织，请加上对应的 --source-org 或 --dest-org`,
  );
}

async function planSessionCopies(
  runtime: DesktopRuntime,
  sourceUuid: string,
  destUuid: string,
  options: SwitchOptions,
): Promise<CopyPlan[]> {
  const root = sessionsRootOf(runtime);
  const sourceOrgs = await listOrgCandidates(path.join(root, sourceUuid));
  const sourceChoice = chooseOrg(sourceOrgs, options.sourceOrg);
  if (!sourceChoice.ok) {
    throw new DesktopError(orgError(text("The current account", "当前账号"), sourceChoice.reason));
  }
  const destOrgs = await listOrgCandidates(path.join(root, destUuid));
  const destChoice = chooseOrg(destOrgs, options.destOrg);
  if (!destChoice.ok) {
    throw new DesktopError(orgError(text("The destination account", "目标账号"), destChoice.reason));
  }
  const { sessions, warnings } = await readSessions(sourceChoice.org.dir);
  for (const warning of warnings) runtime.log(warning);
  const missing: string[] = [];
  const chosen: SessionMeta[] = [];
  for (const id of options.sessionIds) {
    if (normalizeSessionId(id) == null) {
      missing.push(id);
      continue;
    }
    const session = findSession(sessions, id);
    if (session == null) missing.push(id);
    else chosen.push(session);
  }
  if (missing.length > 0) {
    throw new DesktopError(
      text(
        `These sessions are not in the current account: ${listJoin(missing)}`,
        `这些会话不在当前账号里：${listJoin(missing)}`,
      ),
    );
  }
  return planCopies({
    sessions: chosen,
    destDir: destChoice.org.dir,
    overwrite: options.overwrite,
    destExists: existsSync,
  });
}

async function finishAdoption(
  runtime: DesktopRuntime,
  state: FocusState,
  accountUuid: string,
): Promise<void> {
  const known = accountByUuid(state, accountUuid);
  const identity = await identifyAccount(
    runtime,
    runtime.paths.claudeDataDir,
    accountUuid,
    known?.account.organizationUuid ?? null,
  );
  putAccount(state, accountUuid, {
    email: identity.email,
    organizationUuid: identity.organizationUuid,
    adoptedAt: new Date(runtime.now()).toISOString(),
    plan: identity.plan,
  });
  state.currentAccountUuid = accountByUuid(state, accountUuid)?.uuid ?? accountUuid;
  state.pendingPreviousUuid = null;
  await saveState(runtime.paths.statePath, state);
  await rememberAccount(runtime, state.currentAccountUuid, identity.email);
  const saved = accountByUuid(state, accountUuid);
  runtime.log(
    saved?.account.email
      ? text(`Saved ${saved.account.email}`, `已记录 ${saved.account.email}`)
      : text(
          `Saved ${accountUuid}. The email is still unknown.`,
          `已记录 ${accountUuid}。还没有识别到邮箱。`,
        ),
  );
  if (identity.usage) {
    const usage = formatUsage(identity.usage);
    if (usage !== "") runtime.log(usage);
  }
}

export async function initDesktop(
  runtime: DesktopRuntime,
  options?: { relaunch?: boolean },
): Promise<FocusState> {
  const existing = await loadState(runtime.paths.statePath);
  if (existing) {
    const current = existing.currentAccountUuid
      ? accountByUuid(existing, existing.currentAccountUuid)
      : null;
    const label = current?.account.email || existing.currentAccountUuid || text("unknown", "未知");
    throw new DesktopError(
      text(`Already initialized. The current account is ${label}`, `已经初始化，当前账号是 ${label}`),
    );
  }
  await confirmed(
    runtime,
    text(
      "Claude Desktop will quit, the whole data directory will be backed up, and caches will become shared links. Continue?",
      "将退出 Claude Desktop，备份整个数据目录，并把缓存改为共享链接。继续？",
    ),
  );
  const state = await withDesktopStopped(runtime, async () => {
    const backup = await backupLiveIfMissing(
      runtime.paths.claudeDataDir,
      runtime.paths.backupDir,
    );
    runtime.log(
      backup === "created"
        ? text(`Backed up to ${runtime.paths.backupDir}`, `已备份到 ${runtime.paths.backupDir}`)
        : text(
            `A backup already exists. Continuing with ${runtime.paths.backupDir}`,
            `备份已存在，继续使用 ${runtime.paths.backupDir}`,
          ),
    );
    const shared = await ensureShared(
      runtime.paths.claudeDataDir,
      runtime.paths.sharedDir,
    );
    if (shared.moved.length > 0) {
      runtime.log(
        text(
          `Now shared by link: ${listJoin(shared.moved)}`,
          `已改为共享链接：${listJoin(shared.moved)}`,
        ),
      );
    }
    const accountUuid = await readLastKnownAccountUuid(
      desktopConfigPath(runtime.paths.claudeDataDir),
    );
    if (accountUuid == null) {
      throw new DesktopError(
        text(
          "Claude Desktop is not logged in. Log in, then run cfocus account init.",
          "当前 Claude Desktop 没有登录账号。先登录，再运行 cfocus account init。",
        ),
      );
    }
    const identity = await identifyAccount(
      runtime,
      runtime.paths.claudeDataDir,
      accountUuid,
      null,
    );
    const created = emptyState();
    created.currentAccountUuid = accountUuid;
    created.accounts[accountUuid] = {
      email: identity.email,
      organizationUuid: identity.organizationUuid,
      adoptedAt: new Date(runtime.now()).toISOString(),
      plan: identity.plan,
    };
    await saveState(runtime.paths.statePath, created);
    await rememberAccount(runtime, accountUuid, identity.email);
    runtime.log(
      identity.email
        ? text(`Current account ${identity.email}`, `当前账号 ${identity.email}`)
        : text(
            `Current account ${accountUuid}. The email is still unknown. Run cfocus account usage later.`,
            `当前账号 ${accountUuid}。还没有识别到邮箱，稍后运行 cfocus account usage。`,
          ),
    );
    return created;
  });
  if (options?.relaunch !== false) await openDesktop(runtime);
  return state;
}

export async function addAccount(runtime: DesktopRuntime): Promise<void> {
  let state = await loadState(runtime.paths.statePath);
  if (state == null) {
    state = await initDesktop(runtime, { relaunch: false });
  }
  if (state.pendingPreviousUuid) {
    throw new DesktopError(
      text(
        "A login is already unfinished. Run cfocus account adopt when it is done, or cfocus account cancel to restore.",
        "已有未完成的登录。完成后运行 cfocus account adopt，或 cfocus account cancel 恢复。",
      ),
    );
  }
  const current = state.currentAccountUuid;
  if (current == null) {
    throw new DesktopError(
      text("There is no current account, so the login directory cannot be freed.", "没有当前账号，无法腾出登录目录。"),
    );
  }
  await confirmed(
    runtime,
    text(
      "Claude Desktop will quit and open a blank login. The new account is detected after you sign in. Continue?",
      "将退出 Claude Desktop，并打开一个空白登录。登录完成后会自动识别新账号。继续？",
    ),
  );
  await withDesktopStopped(runtime, async () => {
    await parkLiveProfile(
      runtime.paths.claudeDataDir,
      runtime.paths.profilesDir,
      current,
    );
    try {
      await createBlankLive(runtime.paths.claudeDataDir, runtime.paths.sharedDir);
      state.pendingPreviousUuid = current;
      state.currentAccountUuid = null;
      await saveState(runtime.paths.statePath, state);
    } catch (error) {
      if (existsSync(runtime.paths.claudeDataDir)) {
        await removeDirectoryKeepingLinkTargets(runtime.paths.claudeDataDir);
      }
      if (!existsSync(runtime.paths.claudeDataDir)) {
        await restoreParkedProfile(
          runtime.paths.claudeDataDir,
          runtime.paths.profilesDir,
          current,
        );
      }
      state.pendingPreviousUuid = null;
      state.currentAccountUuid = current;
      throw error;
    }
  });
  await openDesktop(runtime);
  runtime.log(
    text(
      "Claude Desktop is open. Log in with the account you want to add.",
      "Claude Desktop 已打开。请登录要添加的账号。",
    ),
  );
  const accountUuid = await waitForAccountUuid({
    configPath: desktopConfigPath(runtime.paths.claudeDataDir),
    blockedUuid: current,
    timeoutMs: runtime.loginTimeoutMs,
    intervalMs: runtime.pollIntervalMs,
    sleep: runtime.sleep,
    now: runtime.now,
  });
  if (accountUuid == null) {
    runtime.log(
      text(
        "No new account yet. After you log in, run cfocus account adopt. To stop, run cfocus account cancel.",
        "还没有检测到新账号。登录完成后运行 cfocus account adopt。不想添加时运行 cfocus account cancel。",
      ),
    );
    return;
  }
  const profile = path.join(runtime.paths.profilesDir, accountUuid);
  if (existsSync(profile)) {
    runtime.log(
      text(
        "This account is already saved. The previous account was restored. Switch with cfocus switch.",
        "这个账号已经保存过。已恢复上一个账号。用 cfocus switch 切换。",
      ),
    );
    await restorePending(runtime, state, current);
    return;
  }
  try {
    await finishAdoption(runtime, state, accountUuid);
  } catch (error) {
    runtime.log(
      text(
        "Could not save this account. Restoring the previous account.",
        "没能记下这个账号，正在恢复上一个账号。",
      ),
    );
    await restorePending(runtime, state, current);
    throw error;
  }
}

export async function adoptAccount(runtime: DesktopRuntime): Promise<void> {
  const state = await requireState(runtime);
  const accountUuid = await readLastKnownAccountUuid(
    desktopConfigPath(runtime.paths.claudeDataDir),
  );
  if (accountUuid == null) {
    throw new DesktopError(
      text(
        "No login detected yet. Log in with Claude Desktop, then run cfocus account adopt.",
        "还没有检测到登录。在 Claude Desktop 登录后，再运行 cfocus account adopt。",
      ),
    );
  }
  if (
    state.pendingPreviousUuid &&
    accountUuid.toLowerCase() === state.pendingPreviousUuid.toLowerCase()
  ) {
    throw new DesktopError(text("This is still the previous account.", "登录的仍是原来的账号。"));
  }
  if (state.pendingPreviousUuid == null) {
    if (state.currentAccountUuid?.toLowerCase() === accountUuid.toLowerCase()) {
      await finishAdoption(runtime, state, accountUuid);
      return;
    }
    throw new DesktopError(
      text(
        "There is no unfinished add. To log in with another account, run cfocus account add.",
        "没有待完成的添加。要登录另一个账号，运行 cfocus account add。",
      ),
    );
  }
  const previous = state.pendingPreviousUuid;
  const profile = path.join(runtime.paths.profilesDir, accountUuid);
  if (existsSync(profile)) {
    runtime.log(
      text(
        "This account is already saved. The previous account was restored. Switch with cfocus switch.",
        "这个账号已经保存过。已恢复上一个账号。用 cfocus switch 切换。",
      ),
    );
    await restorePending(runtime, state, previous);
    return;
  }
  try {
    await finishAdoption(runtime, state, accountUuid);
  } catch (error) {
    runtime.log(
      text(
        "Could not save this account. Restoring the previous account.",
        "没能记下这个账号，正在恢复上一个账号。",
      ),
    );
    await restorePending(runtime, state, previous);
    throw error;
  }
}

async function restorePending(
  runtime: DesktopRuntime,
  state: FocusState,
  previous: string,
): Promise<void> {
  await withDesktopStopped(runtime, async () => {
    if (existsSync(runtime.paths.claudeDataDir)) {
      await removeDirectoryKeepingLinkTargets(runtime.paths.claudeDataDir);
    }
    await restoreParkedProfile(
      runtime.paths.claudeDataDir,
      runtime.paths.profilesDir,
      previous,
    );
    state.currentAccountUuid = previous;
    state.pendingPreviousUuid = null;
    await saveState(runtime.paths.statePath, state);
  });
  const account = accountByUuid(state, previous);
  runtime.log(
    text(
      `Restored ${account?.account.email || previous}`,
      `已恢复 ${account?.account.email || previous}`,
    ),
  );
  await openDesktop(runtime);
}

export async function cancelAdd(runtime: DesktopRuntime): Promise<void> {
  const state = await requireState(runtime);
  const previous = state.pendingPreviousUuid;
  if (previous == null) throw new DesktopError(text("There is no unfinished login.", "没有未完成的登录。"));
  const accountUuid = await readLastKnownAccountUuid(
    desktopConfigPath(runtime.paths.claudeDataDir),
  );
  if (accountUuid != null && !existsSync(path.join(runtime.paths.profilesDir, accountUuid))) {
    throw new DesktopError(
      text(
        "This login already has an account. Run cfocus account adopt to save it.",
        "这次登录已经有账号。运行 cfocus account adopt 保存它。",
      ),
    );
  }
  await confirmed(
    runtime,
    text(
      "This unfinished login will be discarded and the previous account restored. Continue?",
      "将丢掉这次未完成的登录，并恢复上一个账号。继续？",
    ),
  );
  await restorePending(runtime, state, previous);
}

export async function listAccounts(
  runtime: DesktopRuntime,
  withUsage: boolean,
): Promise<void> {
  const state = await requireState(runtime);
  const entries = Object.entries(state.accounts);
  if (entries.length === 0) {
    runtime.log(text("No accounts yet.", "还没有账号。"));
    return;
  }
  entries.sort((left, right) => {
    const leftCurrent =
      state.currentAccountUuid?.toLowerCase() === left[0].toLowerCase();
    const rightCurrent =
      state.currentAccountUuid?.toLowerCase() === right[0].toLowerCase();
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
    return left[1].email.localeCompare(right[1].email);
  });
  const needsPlan = entries.some(([, account]) => account.plan == null);
  let password: string | null = null;
  if (withUsage || needsPlan) {
    try {
      password = await runtime.readPassword();
    } catch (error) {
      runtime.log(
        error instanceof Error ? error.message : text("Could not read the keychain.", "读取钥匙串失败"),
      );
    }
  }
  const rows: AccountListRow[] = [];
  for (const [accountUuid, account] of entries) {
    rows.push(
      await buildAccountRow(runtime, state, accountUuid, account, password, withUsage),
    );
  }
  logAccountTable(runtime, rows);
}

export async function showUsage(
  runtime: DesktopRuntime,
  email?: string,
): Promise<void> {
  const state = await requireState(runtime);
  const target = email
    ? accountByEmail(state, email)
    : state.currentAccountUuid
      ? accountByUuid(state, state.currentAccountUuid)
      : null;
  if (email && target == null) {
    throw new DesktopError(text(`No account for ${email}`, `找不到邮箱 ${email}`));
  }
  if (target == null) throw new DesktopError(text("There is no current account.", "没有当前账号"));
  const password = await runtime.readPassword();
  logAccountTable(runtime, [
    await buildAccountRow(runtime, state, target.uuid, target.account, password, true),
  ]);
}

export async function switchAccount(
  runtime: DesktopRuntime,
  options: SwitchOptions,
): Promise<void> {
  const state = await requireState(runtime);
  if (state.pendingPreviousUuid) {
    throw new DesktopError(
      text(
        "A login is still unfinished. Run cfocus account adopt or cfocus account cancel first.",
        "还有未完成的登录。先 cfocus account adopt 或 cfocus account cancel。",
      ),
    );
  }
  const target = accountByEmail(state, options.toEmail);
  if (target == null) {
    throw new DesktopError(
      text(
        `Cannot find ${options.toEmail}. Log in once with cfocus account add.`,
        `找不到 ${options.toEmail}。先 cfocus account add 登录一次。`,
      ),
    );
  }
  const current = state.currentAccountUuid;
  if (current == null) throw new DesktopError(text("There is no current account.", "没有当前账号"));
  if (current.toLowerCase() === target.uuid.toLowerCase()) {
    runtime.log(
      text(
        `Already using ${target.account.email || target.uuid}`,
        `已经是 ${target.account.email || target.uuid}`,
      ),
    );
    return;
  }
  const plans =
    options.sessionIds.length === 0
      ? []
      : await planSessionCopies(runtime, current, target.uuid, options);
  for (const plan of plans) {
    const verb =
      plan.action === "skip-exists"
        ? text("skip", "跳过")
        : plan.action === "overwrite"
          ? text("overwrite", "覆盖")
          : text("copy", "复制");
    runtime.log(`${verb}  ${plan.title}`);
  }
  const profile = path.join(runtime.paths.profilesDir, target.uuid);
  if (!existsSync(profile)) {
    throw new DesktopError(
      text(
        `Cannot find the profile for ${target.account.email || target.uuid}. Run cfocus account add again.`,
        `找不到 ${target.account.email || target.uuid} 的账号目录。请重新 cfocus account add。`,
      ),
    );
  }
  await confirmed(
    runtime,
    text(
      `Claude Desktop will quit, switch to ${target.account.email || target.uuid}, and open again. Continue?`,
      `将退出 Claude Desktop，切换到 ${target.account.email || target.uuid}，然后重新打开。继续？`,
    ),
  );
  await withDesktopStopped(runtime, async () => {
    if (plans.length > 0) {
      const result = await applyCopies(plans, false);
      runtime.log(
        text(
          `Session indexes: copied ${result.copied}, overwrote ${result.overwritten}, skipped ${result.skipped}.`,
          `会话索引：复制 ${result.copied}，覆盖 ${result.overwritten}，跳过 ${result.skipped}。`,
        ),
      );
    }
    await swapLiveProfile({
      liveDir: runtime.paths.claudeDataDir,
      profilesDir: runtime.paths.profilesDir,
      fromUuid: current,
      toUuid: target.uuid,
    });
    state.currentAccountUuid = target.uuid;
    await saveState(runtime.paths.statePath, state);
  });
  runtime.log(
    text(
      `Switched to ${target.account.email || target.uuid}`,
      `已切换到 ${target.account.email || target.uuid}`,
    ),
  );
  await openDesktop(runtime);
}
