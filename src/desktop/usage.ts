import { isUuid } from "../config.ts";
import { text } from "../i18n.ts";
import { decryptLoginCookies } from "./cookies.ts";
import { DesktopError } from "./errors.ts";
import { planFromBootstrap, type PlanId } from "./plan.ts";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface UsageWindow {
  utilization: number;
  resetsAt: string | null;
}

export interface UsageSummary {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  sevenDaySonnet: UsageWindow | null;
}

export interface FetchLike {
  (
    url: string,
    init?: { headers?: Record<string, string>; method?: string },
  ): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
}

function stringEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.includes("@") || trimmed.includes(" ")) return null;
  return trimmed;
}

function emailFromRecord(record: Record<string, unknown>): string | null {
  return stringEmail(record.email_address) ?? stringEmail(record.email);
}

export function emailFromBootstrap(data: unknown): string | null {
  if (data == null || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const direct = emailFromRecord(record);
  if (direct) return direct;
  for (const key of ["account", "user"] as const) {
    const nested = record[key];
    if (nested == null || typeof nested !== "object" || Array.isArray(nested)) {
      continue;
    }
    const email = emailFromRecord(nested as Record<string, unknown>);
    if (email) return email;
  }
  return null;
}

function readWindow(value: unknown): UsageWindow | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const utilization = record.utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  const resetsAt = typeof record.resets_at === "string" ? record.resets_at : null;
  return { utilization, resetsAt };
}

export function summarizeUsage(data: unknown): UsageSummary {
  if (data == null || typeof data !== "object" || Array.isArray(data)) {
    return { fiveHour: null, sevenDay: null, sevenDaySonnet: null };
  }
  const record = data as Record<string, unknown>;
  return {
    fiveHour: readWindow(record.five_hour),
    sevenDay: readWindow(record.seven_day),
    sevenDaySonnet: readWindow(record.seven_day_sonnet),
  };
}

function cookieHeader(cookies: {
  sessionKey: string;
  cfClearance: string | null;
  lastActiveOrg: string | null;
}): string {
  const parts = [`sessionKey=${cookies.sessionKey}`];
  if (cookies.cfClearance) parts.push(`cf_clearance=${cookies.cfClearance}`);
  if (cookies.lastActiveOrg) parts.push(`lastActiveOrg=${cookies.lastActiveOrg}`);
  return parts.join("; ");
}

async function getJson(
  fetchImpl: FetchLike,
  url: string,
  cookie: string,
): Promise<unknown> {
  let response: { ok: boolean; status: number; json: () => Promise<unknown> };
  try {
    response = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        cookie,
        "user-agent": USER_AGENT,
      },
    });
  } catch {
    throw new DesktopError(text("Could not reach claude.ai", "连接 claude.ai 失败"));
  }
  if (!response.ok) {
    throw new DesktopError(text(`claude.ai returned ${response.status}`, `claude.ai 返回 ${response.status}`));
  }
  try {
    return await response.json();
  } catch {
    throw new DesktopError(text("claude.ai did not return JSON", "claude.ai 的响应不是 JSON"));
  }
}

export interface AccountSnapshot {
  email: string | null;
  organizationUuid: string | null;
  usage: UsageSummary | null;
  plan: PlanId | null;
}

export async function readAccountSnapshot(options: {
  cookiePath: string;
  password: string;
  knownOrganizationUuid: string | null;
  fetchImpl: FetchLike;
  includeUsage?: boolean;
}): Promise<AccountSnapshot> {
  const cookies = decryptLoginCookies(options.cookiePath, options.password);
  const orgFromCookie =
    cookies.lastActiveOrg != null && isUuid(cookies.lastActiveOrg)
      ? cookies.lastActiveOrg
      : null;
  const organizationUuid = orgFromCookie ?? options.knownOrganizationUuid;
  const header = cookieHeader({
    sessionKey: cookies.sessionKey,
    cfClearance: cookies.cfClearance,
    lastActiveOrg: cookies.lastActiveOrg,
  });
  const bootstrap = await getJson(
    options.fetchImpl,
    "https://claude.ai/api/bootstrap",
    header,
  );
  const email = emailFromBootstrap(bootstrap);
  const plan = planFromBootstrap(bootstrap, organizationUuid);
  if (options.includeUsage === false || organizationUuid == null) {
    return { email, organizationUuid, usage: null, plan };
  }
  const usageBody = await getJson(
    options.fetchImpl,
    `https://claude.ai/api/organizations/${organizationUuid}/usage`,
    header,
  );
  return {
    email,
    organizationUuid,
    usage: summarizeUsage(usageBody),
    plan,
  };
}
