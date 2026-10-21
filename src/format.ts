import { formatPlanLabel } from "./desktop/plan.ts";
import { text, type Locale } from "./i18n.ts";

const shanghai = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function formatShanghai(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return text("unknown time", "时间未知");
  const parts = shanghai.formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function formatRemaining(ms: number | null, now = Date.now(), locale?: Locale): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const left = ms - now;
  if (left <= 0) return text("reset", "已重置", locale);
  if (left >= DAY_MS) {
    const days = Math.floor(left / DAY_MS);
    return text(days === 1 ? "1 day left" : `${days} days left`, `剩余 ${days}天`, locale);
  }
  if (left >= HOUR_MS) {
    const hours = Math.floor(left / HOUR_MS);
    return text(hours === 1 ? "1 hour left" : `${hours} hours left`, `剩余 ${hours}小时`, locale);
  }
  const minutes = Math.max(1, Math.round(left / MINUTE_MS));
  if (minutes >= 60) return text("1 hour left", "剩余 1小时", locale);
  return text(minutes === 1 ? "1 min left" : `${minutes} min left`, `剩余 ${minutes}分钟`, locale);
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f9ff)
  );
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

export function padWidth(text: string, width: number): string {
  const gap = width - displayWidth(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

export function truncateWidth(text: string, max: number): string {
  if (max <= 0) return "";
  if (displayWidth(text) <= max) return text;
  if (max === 1) return "…";
  let out = "";
  let width = 0;
  for (const char of text) {
    const charWidth = isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
    if (width + charWidth > max - 1) break;
    out += char;
    width += charWidth;
  }
  return `${out}…`;
}

export interface SessionListRow {
  time: string;
  archived: boolean;
  project: string;
  title: string;
  sessionId: string;
}

function paint(enabled: boolean, code: string, text: string): string {
  if (!enabled || text === "") return text;
  return `\u001b[${code}m${text}\u001b[0m`;
}

export function renderSessionTable(input: {
  email: string;
  accountUuid: string;
  orgUuid: string;
  rows: SessionListRow[];
  total?: number;
  color: boolean;
  columns?: number;
  locale?: Locale;
}): string {
  const color = input.color;
  const columns = input.columns ?? 120;
  const tr = (en: string, zh: string): string => text(en, zh, input.locale);
  const timeHeader = tr("Time", "时间");
  const statusHeader = tr("Status", "状态");
  const projectHeader = tr("Project", "项目");
  const activeLabel = tr("Active", "在用");
  const archivedLabel = tr("Archived", "归档");
  const timeWidth = Math.max(
    16,
    ...input.rows.map((row) => displayWidth(row.time)),
    displayWidth(timeHeader),
  );
  const statusWidth = Math.max(
    displayWidth(statusHeader),
    displayWidth(activeLabel),
    displayWidth(archivedLabel),
  );
  const projectWidth = Math.min(
    28,
    Math.max(4, ...input.rows.map((row) => displayWidth(row.project)), displayWidth(projectHeader)),
  );
  const fixed = timeWidth + 2 + statusWidth + 2 + projectWidth + 2;
  const titleWidth = Math.max(8, Math.min(48, columns - fixed));
  const titleIndent = " ".repeat(fixed);

  const header = [
    paint(color, "2", padWidth(timeHeader, timeWidth)),
    paint(color, "2", padWidth(statusHeader, statusWidth)),
    paint(color, "2", padWidth(projectHeader, projectWidth)),
    paint(color, "2", tr("Title", "标题")),
  ].join("  ");
  const rule = paint(color, "2", "─".repeat(Math.min(columns, fixed + titleWidth)));
  const total = input.total ?? input.rows.length;
  const countLabel =
    total === input.rows.length
      ? tr(`${input.rows.length} sessions`, `${input.rows.length} 条`)
      : tr(`${input.rows.length} of ${total}`, `${input.rows.length} / ${total} 条`);
  const banner = [
    paint(color, "1;36", input.email),
    paint(color, "2", countLabel),
  ].join("  ");
  const meta = paint(
    color,
    "2",
    `${input.accountUuid}   ${tr("org", "组织")} ${input.orgUuid}`,
  );

  const lines = [banner, meta, "", header, rule];
  for (const row of input.rows) {
    const status = row.archived ? archivedLabel : activeLabel;
    const title = truncateWidth(row.title, titleWidth);
    const project = truncateWidth(row.project || "—", projectWidth);
    const main = [
      paint(color, row.archived ? "2" : "36", padWidth(row.time, timeWidth)),
      paint(color, row.archived ? "33" : "32", padWidth(status, statusWidth)),
      paint(color, "34", padWidth(project, projectWidth)),
      paint(color, row.archived ? "2" : "1", title),
    ].join("  ");
    lines.push(main);
    lines.push(paint(color, "2", `${titleIndent}${row.sessionId}`));
  }
  return lines.join("\n");
}

export interface AccountUsageCells {
  fiveHour: number | null;
  sevenDay: number | null;
  sevenDaySonnet: number | null;
  fiveHourResetsAt: string | null;
  sevenDayResetsAt: string | null;
  note: string | null;
}

export interface AccountListRow {
  current: boolean;
  email: string;
  accountUuid: string;
  organizationUuid: string | null;
  plan: string | null;
  expiresAt: number | null;
  expired: boolean;
  expiryNote: string | null;
  note: string | null;
  usage: AccountUsageCells | null;
}

function usageText(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${Math.round(value)}%`;
}

function usagePaint(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "2";
  if (value >= 90) return "31";
  if (value >= 70) return "33";
  return "32";
}

function resetText(iso: string | null | undefined, now: number, locale?: Locale): string {
  if (iso == null || iso === "") return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return formatRemaining(ms, now, locale);
}

function resetPaint(iso: string | null | undefined, now: number): string {
  if (iso == null || iso === "") return "2";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "2";
  return ms - now <= 0 ? "33" : "36";
}

function planPaint(plan: string | null): string {
  if (plan == null || plan === "free") return "2";
  if (plan === "max" || plan === "max_5x" || plan === "max_20x") return "35";
  if (plan === "team" || plan === "enterprise") return "33";
  return "36";
}

export function renderAccountTable(input: {
  rows: AccountListRow[];
  color: boolean;
  columns?: number;
  locale?: Locale;
  now?: number;
}): string {
  const color = input.color;
  const columns = input.columns ?? 120;
  const now = input.now ?? Date.now();
  const tr = (en: string, zh: string): string => text(en, zh, input.locale);
  const showUsage = input.rows.some((row) => row.usage != null);
  const currentLabel = tr("Current", "当前");
  const otherLabel = tr("Other", "备用");
  const statusHeader = tr("Status", "状态");
  const statusWidth = Math.max(
    displayWidth(statusHeader),
    displayWidth(currentLabel),
    displayWidth(otherLabel),
  );
  const unknownEmail = tr("unknown email", "未识别邮箱");
  const emails = input.rows.map((row) => row.email || unknownEmail);
  const emailHeader = tr("Email", "邮箱");
  const emailWidth = Math.min(
    36,
    Math.max(displayWidth(emailHeader), ...emails.map((email) => displayWidth(email))),
  );
  const planHeader = tr("Plan", "档位");
  const planTexts = input.rows.map((row) => formatPlanLabel(row.plan));
  const planWidth = Math.max(
    displayWidth(planHeader),
    ...planTexts.map((plan) => displayWidth(plan)),
  );
  const unknownTime = tr("unknown time", "时间未知");
  const expiryTexts = input.rows.map((row) => {
    if (row.expiryNote) return row.expiryNote;
    if (row.expiresAt == null) return unknownTime;
    const when = formatShanghai(row.expiresAt);
    return row.expired ? tr(`expired ${when}`, `已过期 ${when}`) : when;
  });
  const expiryHeader = tr("Login expires", "登录到期");
  const expiryWidth = Math.max(
    displayWidth(expiryHeader),
    ...expiryTexts.map((expiry) => displayWidth(expiry)),
  );
  const fiveHeader = tr("5 hours", "5 小时");
  const fiveResetHeader = tr("5h left", "5小时剩余");
  const sevenHeader = tr("7 days", "7 天");
  const weekResetHeader = tr("Week left", "周剩余");
  const sonnetHeader = "Sonnet";
  const usageTexts = input.rows.map((row) => ({
    five: usageText(row.usage?.fiveHour ?? null),
    fiveReset: resetText(row.usage?.fiveHourResetsAt, now, input.locale),
    seven: usageText(row.usage?.sevenDay ?? null),
    weekReset: resetText(row.usage?.sevenDayResetsAt, now, input.locale),
    sonnet: usageText(row.usage?.sevenDaySonnet ?? null),
  }));
  const fiveWidth = Math.max(
    displayWidth(fiveHeader),
    ...usageTexts.map((usage) => displayWidth(usage.five)),
  );
  const fiveResetWidth = Math.max(
    displayWidth(fiveResetHeader),
    ...usageTexts.map((usage) => displayWidth(usage.fiveReset)),
  );
  const sevenWidth = Math.max(
    displayWidth(sevenHeader),
    ...usageTexts.map((usage) => displayWidth(usage.seven)),
  );
  const weekResetWidth = Math.max(
    displayWidth(weekResetHeader),
    ...usageTexts.map((usage) => displayWidth(usage.weekReset)),
  );
  const sonnetWidth = Math.max(
    displayWidth(sonnetHeader),
    ...usageTexts.map((usage) => displayWidth(usage.sonnet)),
  );
  const header = [
    paint(color, "2", padWidth(statusHeader, statusWidth)),
    paint(color, "2", padWidth(emailHeader, emailWidth)),
    paint(color, "2", padWidth(planHeader, planWidth)),
    paint(color, "2", padWidth(expiryHeader, expiryWidth)),
  ];
  if (showUsage) {
    header.push(
      paint(color, "2", padWidth(fiveHeader, fiveWidth)),
      paint(color, "2", padWidth(fiveResetHeader, fiveResetWidth)),
      paint(color, "2", padWidth(sevenHeader, sevenWidth)),
      paint(color, "2", padWidth(weekResetHeader, weekResetWidth)),
      paint(color, "2", padWidth(sonnetHeader, sonnetWidth)),
    );
  }
  const tableWidth = Math.min(
    columns,
    statusWidth +
      2 +
      emailWidth +
      2 +
      planWidth +
      2 +
      expiryWidth +
      (showUsage
        ? 2 +
          fiveWidth +
          2 +
          fiveResetWidth +
          2 +
          sevenWidth +
          2 +
          weekResetWidth +
          2 +
          sonnetWidth
        : 0),
  );
  const indent = " ".repeat(statusWidth + 2);
  const lines = [
    [
      paint(color, "1;36", tr("Desktop accounts", "Desktop 账号")),
      paint(color, "2", tr(`${input.rows.length}`, `${input.rows.length} 个`)),
    ].join("  "),
    "",
    header.join("  "),
    paint(color, "2", "─".repeat(Math.max(8, tableWidth))),
  ];
  input.rows.forEach((row, index) => {
    const email = truncateWidth(row.email || unknownEmail, emailWidth);
    const plan = planTexts[index] ?? "—";
    const expiry = truncateWidth(expiryTexts[index] ?? unknownTime, expiryWidth);
    const cells = [
      paint(
        color,
        row.current ? "1;32" : "2",
        padWidth(row.current ? currentLabel : otherLabel, statusWidth),
      ),
      paint(color, row.current ? "1;36" : "36", padWidth(email, emailWidth)),
      paint(color, planPaint(row.plan), padWidth(plan, planWidth)),
      paint(color, row.expired || row.expiryNote ? "33" : "36", padWidth(expiry, expiryWidth)),
    ];
    if (showUsage) {
      const usage = usageTexts[index];
      const five = row.usage?.fiveHour ?? null;
      const seven = row.usage?.sevenDay ?? null;
      const sonnet = row.usage?.sevenDaySonnet ?? null;
      const fiveReset = usage?.fiveReset ?? "—";
      const weekReset = usage?.weekReset ?? "—";
      cells.push(
        paint(color, usagePaint(five), padWidth(usageText(five), fiveWidth)),
        paint(color, resetPaint(row.usage?.fiveHourResetsAt, now), padWidth(fiveReset, fiveResetWidth)),
        paint(color, usagePaint(seven), padWidth(usageText(seven), sevenWidth)),
        paint(color, resetPaint(row.usage?.sevenDayResetsAt, now), padWidth(weekReset, weekResetWidth)),
        paint(color, usagePaint(sonnet), padWidth(usageText(sonnet), sonnetWidth)),
      );
    }
    lines.push(cells.join("  "));
    const note = row.note ?? row.usage?.note ?? "";
    const meta = [
      row.accountUuid,
      row.organizationUuid ? `${tr("org", "组织")} ${row.organizationUuid}` : "",
      note,
    ]
      .filter((part) => part !== "")
      .join("   ");
    lines.push(paint(color, note !== "" ? "33" : "2", `${indent}${meta}`));
  });
  return lines.join("\n");
}

export function baseName(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.at(-1) ?? cwd;
}

export function shortId(id: string): string {
  const bare = id.startsWith("local_") ? id.slice("local_".length) : id;
  return bare.slice(0, 8);
}
