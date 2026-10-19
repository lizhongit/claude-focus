#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  autocompleteMultiselect,
  cancel,
  confirm,
  intro,
  log,
  note,
  outro,
  select,
} from "@clack/prompts";
import {
  accountByEmail,
  ConfigError,
  createInitialConfig,
  defaultConfigPath,
  defaultSessionsRoot,
  loadConfig,
  usableAccounts,
  type AccountConfig,
  type AppConfig,
} from "./config.ts";
import {
  addAccount,
  adoptAccount,
  cancelAdd,
  initDesktop,
  listAccounts,
  showUsage,
  switchAccount,
  type DesktopRuntime,
} from "./desktop/commands.ts";
import {
  launchClaudeDesktop,
  quitClaudeDesktop,
  readSafeStoragePassword,
} from "./desktop/control.ts";
import { focusPaths } from "./desktop/paths.ts";
import type { FetchLike } from "./desktop/usage.ts";
import { baseName, formatShanghai, renderSessionTable, shortId } from "./format.ts";
import { claudeDesktopRunning } from "./process.ts";
import {
  chooseOrg,
  findSession,
  listOrgCandidates,
  normalizeSessionId,
  readSessions,
  type OrgCandidate,
  type SessionMeta,
} from "./sessions.ts";
import { listJoin, localeFromEnv, setLocale, text } from "./i18n.ts";
import { applyCopies, planCopies, type CopyPlan } from "./sync.ts";

interface Flags {
  config?: string;
  from?: string;
  to?: string;
  sessions: string[];
  dryRun: boolean;
  overwrite: boolean;
  sourceOrg?: string;
  destOrg?: string;
  yes: boolean;
  usage: boolean;
  help: boolean;
  lang?: "en" | "zh";
}

export interface ParsedArgs {
  command: string;
  subcommand?: string;
  email?: string;
  flags: Flags;
}

function printHelp(): void {
  console.log(text(
    `cfocus — switch Claude Desktop subscription accounts on this Mac and copy Code session indexes

Usage
  cfocus                         Pick a source account, sessions, and a destination
  cfocus init                    Build the email map from local session directories
  cfocus accounts                Show email, account UUID, and organization UUID
  cfocus list [email]            List sessions
  cfocus sync --from <email> --to <email> --session <id> [--dry-run]

  cfocus account init [--yes]    Back up Desktop data and share caches by symlink
  cfocus account add [--yes]     Open a blank login and detect the new account
  cfocus account adopt           Save an account after you finish logging in
  cfocus account cancel [--yes]  Drop an unfinished login and restore the previous account
  cfocus account list [--usage]  List saved accounts, plan, and login expiry
  cfocus account usage [email]   Query usage. Decrypt in memory only; nothing is written to disk
  cfocus switch --to <email> [--session <id>] [--yes]

Options
  --lang <en|zh>        Language. Defaults to Chinese when LANG starts with zh, otherwise English
  --config <path>       Email map. Default ~/.config/claude-focus/accounts.json
  --from <email>        Source account
  --to <email>          Destination account
  --session <id>        Session id. Repeatable. Accepts a local_ prefix or a bare UUID
  --source-org <uuid>   Source organization, when one account has several session orgs
  --dest-org <uuid>     Destination organization
  --dry-run             Print the paths that would be copied
  --overwrite           Replace an existing session index
  --yes                 Do not ask before quitting or switching Desktop
  --usage               With account list, query usage and refresh the plan
  --help                Show this help

Session indexes live in claude-code-sessions/<account>/<org>/local_*.json.
Transcripts stay in ~/.claude/projects and are shared. They are not copied.
Switching quits Claude Desktop, swaps in that account's data directory, and opens it once.
Caches and the session directory are shared by symlink instead of copied per account.
The first account init keeps one full backup of the current data directory.
`,
    `cfocus — 在本机的多个 Claude Desktop 订阅账号之间切换，并复制 Code 会话索引

用法
  cfocus                         交互选择来源、会话和目标
  cfocus init                    按本机会话目录生成邮箱映射
  cfocus accounts                查看邮箱、账号 UUID、组织 UUID
  cfocus list [邮箱]             列出会话
  cfocus sync --from <邮箱> --to <邮箱> --session <id> [--dry-run]

  cfocus account init [--yes]    备份 Desktop 数据，并把缓存改为共享链接
  cfocus account add [--yes]     打开空白登录，自动识别新账号
  cfocus account adopt           登录完成后补记账号
  cfocus account cancel [--yes]  放弃未完成的登录，恢复上一个账号
  cfocus account list [--usage]  查看已保存的 Desktop 账号、订阅档位和会话到期时间
  cfocus account usage [邮箱]    查询额度。只在内存里解密，不写盘
  cfocus switch --to <邮箱> [--session <id>] [--yes]

选项
  --lang <en|zh>        语言。LANG 以 zh 开头时用中文，否则用英文
  --config <路径>       会话邮箱映射，默认 ~/.config/claude-focus/accounts.json
  --from <邮箱>         来源账号
  --to <邮箱>           目标账号
  --session <id>        会话 ID，可重复。接受 local_ 前缀或裸 UUID
  --source-org <uuid>   来源组织。一个账号有多个含会话的组织时才需要
  --dest-org <uuid>     目标组织
  --dry-run             只打印将要复制的路径
  --overwrite           目标已有同名索引时覆盖
  --yes                 退出或切换 Desktop 时不再询问
  --usage               account list 时查询额度，并刷新订阅档位
  --help                显示帮助

会话索引是 claude-code-sessions/<账号>/<组织>/local_*.json。
对话正文在 ~/.claude/projects，两边共用，不复制。
切换账号会退出 Claude Desktop，换上该账号的整份数据目录，再打开一次。
缓存和会话目录用符号链接共享，不按账号各存一份。
第一次 account init 会把当前数据目录完整备份。
`,
  ));
}

function applyLanguage(argv: string[]): void {
  const index = argv.indexOf("--lang");
  if (index < 0) {
    setLocale(localeFromEnv());
    return;
  }
  const value = argv[index + 1];
  if (value === "en" || value === "zh") {
    setLocale(value);
    return;
  }
  setLocale(localeFromEnv());
  throw new ConfigError(text("--lang must be en or zh", "--lang 只能是 en 或 zh"));
}

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Flags = {
    sessions: [],
    dryRun: false,
    overwrite: false,
    yes: false,
    usage: false,
    help: false,
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg == null) continue;
    if (arg === "--help" || arg === "-h") {
      flags.help = true;
      continue;
    }
    if (arg === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (arg === "--overwrite") {
      flags.overwrite = true;
      continue;
    }
    if (arg === "--yes") {
      flags.yes = true;
      continue;
    }
    if (arg === "--usage") {
      flags.usage = true;
      continue;
    }
    if (arg === "--lang") {
      const value = argv[i + 1];
      if (value !== "en" && value !== "zh") {
        throw new ConfigError(text("--lang must be en or zh", "--lang 只能是 en 或 zh"));
      }
      i += 1;
      flags.lang = value;
      continue;
    }
    const next = (): string => {
      const value = argv[i + 1];
      if (value == null || value.startsWith("--")) {
        throw new ConfigError(text(`${arg} needs a value`, `${arg} 需要一个值`));
      }
      i += 1;
      return value;
    };
    if (arg === "--config") {
      flags.config = next();
      continue;
    }
    if (arg === "--from") {
      flags.from = next();
      continue;
    }
    if (arg === "--to") {
      flags.to = next();
      continue;
    }
    if (arg === "--session") {
      flags.sessions.push(next());
      continue;
    }
    if (arg === "--source-org") {
      flags.sourceOrg = next();
      continue;
    }
    if (arg === "--dest-org") {
      flags.destOrg = next();
      continue;
    }
    if (arg.startsWith("--")) throw new ConfigError(text(`Unknown option: ${arg}`, `未知选项：${arg}`));
    positionals.push(arg);
  }
  const command = positionals[0] ?? "interactive";
  if (command === "account") {
    const subcommand = positionals[1];
    if (subcommand == null) {
      throw new ConfigError(
        text(
          "account needs a subcommand: init, add, adopt, cancel, list, usage",
          "account 需要子命令：init、add、adopt、cancel、list、usage",
        ),
      );
    }
    const email = subcommand === "usage" ? positionals[2] : undefined;
    const max = subcommand === "usage" ? 3 : 2;
    if (positionals.length > max) {
      throw new ConfigError(
        text(`account ${subcommand} has extra arguments`, `account ${subcommand} 有多余参数`),
      );
    }
    return { command, subcommand, ...(email != null ? { email } : {}), flags };
  }
  if (command === "switch") {
    if (positionals.length > 1) {
      throw new ConfigError(
        text("switch only accepts --to, not positional arguments", "switch 只用 --to，不接受位置参数"),
      );
    }
    return { command, flags };
  }
  if (command !== "list" && positionals.length > 1) {
    throw new ConfigError(
      text(
        `Unknown arguments: ${positionals.slice(1).join(" ")}`,
        `未知参数：${positionals.slice(1).join(" ")}`,
      ),
    );
  }
  if (command === "list" && positionals.length > 2) {
    throw new ConfigError(text("list accepts only one email", "list 只接受一个邮箱"));
  }
  const email = positionals[1];
  return { command, ...(email != null ? { email } : {}), flags };
}

function desktopRuntime(flags: Flags): DesktopRuntime {
  return {
    paths: focusPaths(),
    configPath: flags.config ?? defaultConfigPath(),
    claudeJsonPath: path.join(homedir(), ".claude.json"),
    yes: flags.yes,
    isTTY: process.stdin.isTTY === true,
    quitTimeoutMs: 20_000,
    loginTimeoutMs: 10 * 60_000,
    pollIntervalMs: 2_000,
    quit: quitClaudeDesktop,
    launch: launchClaudeDesktop,
    isRunning: claudeDesktopRunning,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    readPassword: readSafeStoragePassword,
    fetch: globalThis.fetch as FetchLike,
    confirm: async (message) => {
      const answer = await confirm({
        message,
        active: text("Continue", "继续"),
        inactive: text("Cancel", "取消"),
      });
      return answer === true;
    },
    log: (message) => console.log(message),
    color: process.stdout.isTTY === true && process.env.NO_COLOR == null,
    ...(process.stdout.columns != null ? { columns: process.stdout.columns } : {}),
  };
}

async function runDesktop(parsed: ParsedArgs): Promise<void> {
  const runtime = desktopRuntime(parsed.flags);
  if (parsed.command === "switch") {
    if (!parsed.flags.to) throw new ConfigError(text("switch needs --to <email>", "switch 需要 --to <邮箱>"));
    await switchAccount(runtime, {
      toEmail: parsed.flags.to,
      sessionIds: parsed.flags.sessions,
      overwrite: parsed.flags.overwrite,
      ...(parsed.flags.sourceOrg ? { sourceOrg: parsed.flags.sourceOrg } : {}),
      ...(parsed.flags.destOrg ? { destOrg: parsed.flags.destOrg } : {}),
    });
    return;
  }
  switch (parsed.subcommand) {
    case "init":
      await initDesktop(runtime);
      return;
    case "add":
      await addAccount(runtime);
      return;
    case "adopt":
      await adoptAccount(runtime);
      return;
    case "cancel":
      await cancelAdd(runtime);
      return;
    case "list":
      await listAccounts(runtime, parsed.flags.usage);
      return;
    case "usage":
      await showUsage(runtime, parsed.email);
      return;
    default:
      throw new ConfigError(
        text(
          `Unknown account subcommand: ${parsed.subcommand ?? ""}`,
          `未知的 account 子命令：${parsed.subcommand ?? ""}`,
        ),
      );
  }
}

function orgError(accountLabel: string, orgs: OrgCandidate[]): string {
  if (orgs.length === 0) {
    return text(
      `${accountLabel} has no organization directory`,
      `${accountLabel} 下面没有组织目录`,
    );
  }
  const lines = orgs.map(
    (org) =>
      `  ${org.orgUuid}  ${text(`${org.sessionCount} sessions`, `${org.sessionCount} 条会话`)}`,
  );
  return text(
    `${accountLabel} has more than one organization. Pass --source-org or --dest-org:\n${lines.join("\n")}`,
    `${accountLabel} 有多个组织目录，请加上 --source-org 或 --dest-org：\n${lines.join("\n")}`,
  );
}

async function resolveOrg(
  account: AccountConfig,
  sessionsRoot: string,
  explicitOrg: string | undefined,
  role: "source" | "destination",
): Promise<OrgCandidate> {
  const accountDir = path.join(sessionsRoot, account.accountUuid);
  const orgs = await listOrgCandidates(accountDir);
  const choice = chooseOrg(orgs, explicitOrg);
  const roleLabel = text(
    role === "source" ? "Source" : "Destination",
    role === "source" ? "来源" : "目标",
  );
  if (!choice.ok) {
    throw new ConfigError(
      choice.reason === "none" && explicitOrg
        ? text(
            `${roleLabel} organization ${explicitOrg} is not under ${account.email}`,
            `${roleLabel}组织 ${explicitOrg} 不在账号 ${account.email} 下面`,
          )
        : orgError(
            text(
              `${roleLabel} account ${account.email || account.accountUuid}`,
              `${roleLabel}账号 ${account.email || account.accountUuid}`,
            ),
            choice.reason === "ambiguous" ? choice.orgs : orgs,
          ),
    );
  }
  return choice.org;
}

function printPlan(plans: CopyPlan[], dryRun: boolean): void {
  console.log(
    dryRun
      ? text("Preview only. Nothing will be written.", "预览，不会写入。")
      : text("Ready to write.", "准备写入。"),
  );
  console.log(
    text(
      "Transcripts stay in ~/.claude/projects and are shared. This copy does not duplicate them.",
      "对话正文在 ~/.claude/projects，两边共用同一份，这次不复制。",
    ),
  );
  for (const plan of plans) {
    const verb =
      plan.action === "skip-exists"
        ? text("skip, destination already has this index", "跳过，目标已有同名索引")
        : plan.action === "overwrite"
          ? text("overwrite", "覆盖")
          : text("copy", "复制");
    console.log("");
    console.log(`${verb}  ${plan.title}`);
    console.log(`  ${text("from", "从")} ${plan.sourcePath}`);
    console.log(`  ${text("to", "到")} ${plan.destPath}`);
    if (plan.cliSessionId) console.log(`  ${text("transcript", "正文")} ${plan.cliSessionId}`);
  }
}

async function runSync(options: {
  config: AppConfig;
  fromEmail: string;
  toEmail: string;
  sessionIds: string[];
  dryRun: boolean;
  overwrite: boolean;
  sourceOrg?: string;
  destOrg?: string;
}): Promise<number> {
  const from = accountByEmail(options.config, options.fromEmail);
  const to = accountByEmail(options.config, options.toEmail);
  if (from.accountUuid.toLowerCase() === to.accountUuid.toLowerCase()) {
    throw new ConfigError(text("Source and destination are the same account", "来源和目标是同一个账号"));
  }
  const sourceOrg = await resolveOrg(
    from,
    options.config.sessionsRoot,
    options.sourceOrg,
    "source",
  );
  const destOrg = await resolveOrg(
    to,
    options.config.sessionsRoot,
    options.destOrg,
    "destination",
  );
  if (sourceOrg.sessionCount === 0) {
    throw new ConfigError(
      text(
        `${from.email} has no sessions in organization ${sourceOrg.orgUuid}`,
        `${from.email} 的组织 ${sourceOrg.orgUuid} 里没有会话`,
      ),
    );
  }
  const { sessions, warnings } = await readSessions(sourceOrg.dir);
  for (const warning of warnings) log.warn(warning);
  const missing: string[] = [];
  const chosen: SessionMeta[] = [];
  for (const id of options.sessionIds) {
    if (normalizeSessionId(id) == null) {
      missing.push(id);
      continue;
    }
    const session = findSession(sessions, id);
    if (!session) missing.push(id);
    else chosen.push(session);
  }
  if (missing.length > 0) {
    throw new ConfigError(
      text(
        `These sessions are not in the source account: ${listJoin(missing)}`,
        `这些会话不在来源账号里：${listJoin(missing)}`,
      ),
    );
  }
  const plans = planCopies({
    sessions: chosen,
    destDir: destOrg.dir,
    overwrite: options.overwrite,
    destExists: existsSync,
  });
  printPlan(plans, options.dryRun);
  const willWrite = plans.some((plan) => plan.action !== "skip-exists");
  if (!options.dryRun && willWrite && claudeDesktopRunning()) {
    log.error(
      text(
        "Claude Desktop is running. Quit it completely, then copy again.",
        "Claude Desktop 正在运行。先完全退出，再重新执行复制。",
      ),
    );
    return 1;
  }
  const result = await applyCopies(plans, options.dryRun);
  console.log("");
  console.log(
    options.dryRun
      ? text(
          `Preview finished. Would copy ${result.copied}, overwrite ${result.overwritten}, skip ${result.skipped}.`,
          `预览结束。将复制 ${result.copied}，覆盖 ${result.overwritten}，跳过 ${result.skipped}。`,
        )
      : text(
          `Done. Copied ${result.copied}, overwrote ${result.overwritten}, skipped ${result.skipped}.`,
          `完成。复制 ${result.copied}，覆盖 ${result.overwritten}，跳过 ${result.skipped}。`,
        ),
  );
  return 0;
}

async function runList(config: AppConfig, email?: string): Promise<void> {
  const accounts = email
    ? [accountByEmail(config, email)]
    : usableAccounts(config);
  if (accounts.length === 0) {
    throw new ConfigError(
      text(
        "No emails are filled in yet. Edit accounts.json, then list again.",
        "配置里还没有填写邮箱。编辑 accounts.json 后再列出。",
      ),
    );
  }
  for (const account of accounts) {
    const accountDir = path.join(config.sessionsRoot, account.accountUuid);
    const orgs = await listOrgCandidates(accountDir);
    const visible = orgs.filter((org) => org.sessionCount > 0);
    const targets = visible.length > 0 ? visible : orgs;
    if (targets.length === 0) {
      console.log(`\n${account.email}`);
      console.log(`  ${account.accountUuid}`);
      console.log(`  ${text("no organization directory", "没有组织目录")}`);
      continue;
    }
    for (const org of targets) {
      if (org.sessionCount === 0) {
        console.log(`\n${account.email}`);
        console.log(`  ${account.accountUuid}   ${text("org", "组织")} ${org.orgUuid}`);
        console.log(`  ${text("no sessions", "没有会话")}`);
        continue;
      }
      const { sessions, warnings } = await readSessions(org.dir);
      for (const warning of warnings) log.warn(warning);
      console.log("");
      console.log(
        renderSessionTable({
          email: account.email,
          accountUuid: account.accountUuid,
          orgUuid: org.orgUuid,
          color: process.stdout.isTTY === true && process.env.NO_COLOR == null,
          ...(process.stdout.columns != null ? { columns: process.stdout.columns } : {}),
          rows: sessions.map((session) => ({
            time: formatShanghai(session.lastActivityAt),
            archived: session.isArchived,
            project: baseName(session.cwd),
            title: session.title,
            sessionId: session.sessionId,
          })),
        }),
      );
    }
  }
  console.log("");
}

async function runAccounts(config: AppConfig): Promise<void> {
  if (config.accounts.length === 0) {
    console.log(
      text(
        "The config has no accounts. Check the session directory and run init again.",
        "配置里没有账号。确认会话目录后重新 init。",
      ),
    );
    console.log(config.sessionsRoot);
    return;
  }
  for (const account of config.accounts) {
    const label =
      account.email === "" ? text("email not set", "未填写邮箱") : account.email;
    console.log(label);
    console.log(`  ${text("account", "账号")} ${account.accountUuid}`);
    const orgs = await listOrgCandidates(
      path.join(config.sessionsRoot, account.accountUuid),
    );
    if (orgs.length === 0) console.log(`  ${text("no organization directory", "没有组织目录")}`);
    for (const org of orgs) {
      console.log(
        `  ${text("org", "组织")} ${org.orgUuid}  ${text(`${org.sessionCount} sessions`, `${org.sessionCount} 条会话`)}`,
      );
    }
  }
}

async function runInit(configPath: string): Promise<void> {
  if (existsSync(configPath)) {
    throw new ConfigError(text(`Config already exists: ${configPath}`, `配置已存在：${configPath}`));
  }
  const config = await createInitialConfig({
    configPath,
    sessionsRoot: defaultSessionsRoot(),
    claudeJsonPath: path.join(homedir(), ".claude.json"),
  });
  console.log(text(`Wrote ${configPath}`, `已写入 ${configPath}`));
  const blank = config.accounts.filter((account) => account.email === "").length;
  console.log(
    text(
      `Found ${config.accounts.length} account directories.`,
      `发现 ${config.accounts.length} 个账号目录。`,
    ),
  );
  if (blank > 0) {
    console.log(
      text(
        `${blank} accounts have an empty email. Fill them in before those accounts can be selected.`,
        `${blank} 个账号的邮箱是空的。填好之后才能选这些账号。`,
      ),
    );
  }
}

function stopIfCancel(value: string | symbol): string;
function stopIfCancel(value: readonly string[] | symbol): readonly string[];
function stopIfCancel(
  value: string | readonly string[] | symbol,
): string | readonly string[] {
  if (typeof value === "symbol") {
    cancel(text("Cancelled.", "已取消"));
    process.exit(0);
    throw new Error(text("Cancelled.", "已取消"));
  }
  return value;
}

async function runInteractive(config: AppConfig, flags: Flags): Promise<number> {
  const accounts = usableAccounts(config);
  if (accounts.length < 2) {
    throw new ConfigError(
      text(
        "At least two accounts need an email. Edit the config, then run cfocus again.",
        "至少要有两个已填写邮箱的账号。编辑配置后再运行 cfocus。",
      ),
    );
  }
  intro("cfocus");
  if (claudeDesktopRunning()) {
    log.warn(
      text(
        "Claude Desktop is running. You can preview a selection, but writing waits until the app has quit.",
        "Claude Desktop 正在运行。可以选会话看预览，退出应用后才能写入。",
      ),
    );
  }
  const fromEmail = stopIfCancel(
    await select({
      message: text("Copy from which account", "从哪个账号复制"),
      initialValue: flags.from,
      options: accounts.map((account) => ({
        value: account.email,
        label: account.email,
        hint: shortId(account.accountUuid),
      })),
    }),
  );
  const from = accountByEmail(config, fromEmail);
  const sourceOrg = await resolveOrg(from, config.sessionsRoot, flags.sourceOrg, "source");
  const { sessions, warnings } = await readSessions(sourceOrg.dir);
  for (const warning of warnings) log.warn(warning);
  if (sessions.length === 0) {
    throw new ConfigError(
      text(`${from.email} has no sessions`, `${from.email} 下面没有会话`),
    );
  }
  const preset = flags.sessions
    .map((id) => normalizeSessionId(id))
    .filter((id): id is string => id != null);
  const selected = stopIfCancel(
    await autocompleteMultiselect({
      message: text("Which sessions to copy", "同步哪些会话"),
      placeholder: text("Type a title, project, or session id", "输入标题、项目或会话 ID"),
      required: true,
      initialValues: preset,
      maxItems: 8,
      options: sessions.map((session) => ({
        value: session.sessionId,
        label: session.title,
        hint: `${formatShanghai(session.lastActivityAt)}  ${baseName(session.cwd) || shortId(session.sessionId)}${session.isArchived ? text("  archived", "  已归档") : ""}`,
      })),
    }),
  );
  const destinations = accounts.filter(
    (account) => account.accountUuid.toLowerCase() !== from.accountUuid.toLowerCase(),
  );
  const toEmail = stopIfCancel(
    await select({
      message: text("Copy to which account", "复制到哪个账号"),
      initialValue: flags.to,
      options: destinations.map((account) => ({
        value: account.email,
        label: account.email,
        hint: shortId(account.accountUuid),
      })),
    }),
  );
  const to = accountByEmail(config, toEmail);
  const destOrg = await resolveOrg(to, config.sessionsRoot, flags.destOrg, "destination");
  const chosen = selected
    .map((id) => findSession(sessions, id))
    .filter((session): session is SessionMeta => session != null);
  const plans = planCopies({
    sessions: chosen,
    destDir: destOrg.dir,
    overwrite: flags.overwrite,
    destExists: existsSync,
  });
  note(
    [
      `${from.email}  →  ${to.email}`,
      `${text("Destination org", "目标组织")} ${destOrg.orgUuid}`,
      ...plans.map((plan) => {
        const verb =
          plan.action === "skip-exists"
            ? text("skip", "跳过")
            : plan.action === "overwrite"
              ? text("overwrite", "覆盖")
              : text("copy", "复制");
        return `${verb}  ${plan.title}`;
      }),
      text(
        "Transcripts are not copied. Both accounts keep pointing at the same conversation.",
        "正文不复制，两边仍指向同一份对话。",
      ),
    ].join("\n"),
    text("Copy preview", "同步预览"),
  );
  const desktopOpen = claudeDesktopRunning();
  const willWrite = plans.some((plan) => plan.action !== "skip-exists");
  if (desktopOpen && willWrite) {
    log.error(
      text(
        "Quit Claude Desktop completely, then run the write again.",
        "先完全退出 Claude Desktop，再运行一次写入。",
      ),
    );
    printPlan(plans, true);
    outro(text("Nothing written", "未写入"));
    return 1;
  }
  if (!willWrite) {
    outro(
      text(
        "The destination already has these indexes. There is nothing to copy.",
        "目标里都已有这些索引，没有要复制的文件",
      ),
    );
    return 0;
  }
  const proceed = await confirm({
    message: flags.dryRun
      ? text("Print the path preview?", "打印路径预览？")
      : text("Write these indexes?", "写入这些索引？"),
    active: flags.dryRun ? text("Preview", "预览") : text("Write", "写入"),
    inactive: text("Cancel", "取消"),
    initialValue: !flags.dryRun,
  });
  if (typeof proceed === "symbol" || !proceed) {
    if (typeof proceed === "symbol") cancel(text("Cancelled.", "已取消"));
    outro(text("Cancelled.", "已取消"));
    return 0;
  }
  printPlan(plans, flags.dryRun);
  const result = await applyCopies(plans, flags.dryRun);
  outro(
    flags.dryRun
      ? text(
          `Preview finished. Would copy ${result.copied}, skip ${result.skipped}.`,
          `预览结束。将复制 ${result.copied}，跳过 ${result.skipped}。`,
        )
      : text(
          `Done. Copied ${result.copied}, skipped ${result.skipped}.`,
          `完成。复制 ${result.copied}，跳过 ${result.skipped}。`,
        ),
  );
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  applyLanguage(argv);
  const parsed = parseArgs(argv);
  const { command, email, flags } = parsed;
  if (flags.help || command === "help") {
    printHelp();
    return;
  }
  if (command === "account" || command === "switch") {
    await runDesktop(parsed);
    return;
  }
  const configPath = flags.config ?? defaultConfigPath();
  if (command === "init") {
    await runInit(configPath);
    return;
  }
  const config = await loadConfig(configPath);
  if (command === "accounts") {
    await runAccounts(config);
    return;
  }
  if (command === "list") {
    await runList(config, email);
    return;
  }
  if (command === "sync") {
    if (!flags.from || !flags.to || flags.sessions.length === 0) {
      throw new ConfigError(
        text(
          "sync needs --from, --to, and at least one --session",
          "sync 需要 --from、--to 和至少一个 --session",
        ),
      );
    }
    const code = await runSync({
      config,
      fromEmail: flags.from,
      toEmail: flags.to,
      sessionIds: flags.sessions,
      dryRun: flags.dryRun,
      overwrite: flags.overwrite,
      ...(flags.sourceOrg ? { sourceOrg: flags.sourceOrg } : {}),
      ...(flags.destOrg ? { destOrg: flags.destOrg } : {}),
    });
    process.exitCode = code;
    return;
  }
  if (command === "interactive") {
    const code = await runInteractive(config, flags);
    process.exitCode = code;
    return;
  }
  throw new ConfigError(text(`Unknown command: ${command}`, `未知命令：${command}`));
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry == null || entry.length === 0) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (process.stdout.isTTY) {
      log.error(message);
    } else {
      console.error(message);
    }
    process.exitCode = 1;
  });
}
