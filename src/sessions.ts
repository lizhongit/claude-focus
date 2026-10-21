import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { text } from "./i18n.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_FILE_RE =
  /^local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

export interface OrgCandidate {
  orgUuid: string;
  dir: string;
  sessionCount: number;
}

export type OrgChoice =
  | { ok: true; org: OrgCandidate }
  | { ok: false; reason: "none" }
  | { ok: false; reason: "ambiguous"; orgs: OrgCandidate[] };

export interface SessionMeta {
  sessionId: string;
  fileName: string;
  filePath: string;
  title: string;
  cwd: string;
  lastActivityAt: number | null;
  createdAt: number | null;
  isArchived: boolean;
  cliSessionId: string | null;
  childSessionIds: string[];
}

export interface ChildExpansion {
  sessions: SessionMeta[];
  missing: string[];
}

export function chooseOrg(
  orgs: OrgCandidate[],
  explicitOrg?: string,
): OrgChoice {
  if (explicitOrg) {
    const found = orgs.find(
      (org) => org.orgUuid.toLowerCase() === explicitOrg.toLowerCase(),
    );
    if (!found) return { ok: false, reason: "none" };
    return { ok: true, org: found };
  }
  const withSessions = orgs.filter((org) => org.sessionCount > 0);
  if (withSessions.length === 1) {
    const org = withSessions[0];
    if (!org) return { ok: false, reason: "none" };
    return { ok: true, org };
  }
  if (withSessions.length > 1) {
    return { ok: false, reason: "ambiguous", orgs: withSessions };
  }
  if (orgs.length === 1) {
    const org = orgs[0];
    if (!org) return { ok: false, reason: "none" };
    return { ok: true, org };
  }
  if (orgs.length === 0) return { ok: false, reason: "none" };
  return { ok: false, reason: "ambiguous", orgs };
}

export function normalizeSessionId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.includes("/") || trimmed.includes("\\")) return null;
  const withPrefix = trimmed.startsWith("local_") ? trimmed : `local_${trimmed}`;
  const fileName = withPrefix.endsWith(".json")
    ? withPrefix
    : `${withPrefix}.json`;
  if (!SESSION_FILE_RE.test(fileName)) return null;
  return fileName.slice(0, -".json".length);
}

export async function listOrgCandidates(
  accountDir: string,
): Promise<OrgCandidate[]> {
  let entries;
  try {
    entries = await readdir(accountDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const orgs: OrgCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
    const dir = path.join(accountDir, entry.name);
    const names = await readdir(dir);
    const sessionCount = names.filter((name) => SESSION_FILE_RE.test(name)).length;
    orgs.push({ orgUuid: entry.name, dir, sessionCount });
  }
  orgs.sort((a, b) => a.orgUuid.localeCompare(b.orgUuid));
  return orgs;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function childSessionIdsFrom(record: Record<string, unknown>): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const key of ["sideSessionNotes", "queuedSideSessionNotes"]) {
    const list = record[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item == null || typeof item !== "object" || Array.isArray(item)) continue;
      const raw = (item as Record<string, unknown>).sessionId;
      if (typeof raw !== "string") continue;
      const id = normalizeSessionId(raw);
      if (id == null) continue;
      const folded = id.toLowerCase();
      if (seen.has(folded)) continue;
      seen.add(folded);
      ids.push(id);
    }
  }
  return ids;
}

export function expandChildSessions(sessions: SessionMeta[], roots: SessionMeta[]): ChildExpansion {
  const byId = new Map(sessions.map((session) => [session.sessionId.toLowerCase(), session]));
  const out: SessionMeta[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];
  const missingSeen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null) continue;
    const key = current.sessionId.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(current);
    for (const childId of current.childSessionIds) {
      const child = byId.get(childId.toLowerCase());
      if (child == null) {
        const folded = childId.toLowerCase();
        if (!missingSeen.has(folded)) {
          missingSeen.add(folded);
          missing.push(childId);
        }
        continue;
      }
      queue.push(child);
    }
  }
  return { sessions: out, missing };
}

export function childExpansionNotes(chosenCount: number, expanded: ChildExpansion): string[] {
  const notes: string[] = [];
  const extra = expanded.sessions.length - chosenCount;
  if (extra > 0) {
    notes.push(
      text(
        `Including ${extra} related sessions.`,
        `一并带上 ${extra} 个关联子会话。`,
      ),
    );
  }
  for (const id of expanded.missing) {
    notes.push(
      text(
        `Related session ${id} is not in the source account, so it was not copied.`,
        `关联子会话 ${id} 不在来源账号里，没有复制。`,
      ),
    );
  }
  return notes;
}

export function parseSessionMeta(
  filePath: string,
  raw: unknown,
): SessionMeta | { error: string } {
  const fileName = path.basename(filePath);
  const sessionId = fileName.slice(0, -".json".length);
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: text(`${fileName} is not a JSON object`, `${fileName} 不是 JSON 对象`) };
  }
  const record = raw as Record<string, unknown>;
  const title =
    typeof record.title === "string" && record.title.trim() !== ""
      ? record.title.trim()
      : text("Untitled session", "未命名会话");
  const cwd = typeof record.cwd === "string" ? record.cwd : "";
  const cliSessionId =
    typeof record.cliSessionId === "string" && record.cliSessionId !== ""
      ? record.cliSessionId
      : null;
  return {
    sessionId,
    fileName,
    filePath,
    title,
    cwd,
    lastActivityAt: numberOrNull(record.lastActivityAt),
    createdAt: numberOrNull(record.createdAt),
    isArchived: record.isArchived === true,
    cliSessionId,
    childSessionIds: childSessionIdsFrom(record),
  };
}

export async function readSessions(orgDir: string): Promise<{
  sessions: SessionMeta[];
  warnings: string[];
}> {
  const names = (await readdir(orgDir))
    .filter((name) => SESSION_FILE_RE.test(name))
    .sort();
  const sessions: SessionMeta[] = [];
  const warnings: string[] = [];
  for (const name of names) {
    const filePath = path.join(orgDir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    } catch {
      warnings.push(text(`${name} could not be parsed and was skipped`, `${name} 无法解析，已跳过`));
      continue;
    }
    const parsed = parseSessionMeta(filePath, raw);
    if ("error" in parsed) {
      warnings.push(parsed.error);
      continue;
    }
    sessions.push(parsed);
  }
  sessions.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  return { sessions, warnings };
}

export function findSession(
  sessions: SessionMeta[],
  sessionId: string,
): SessionMeta | undefined {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return undefined;
  return sessions.find((session) => session.sessionId === normalized);
}
