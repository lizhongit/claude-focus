import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { formatShanghai } from "../src/format.ts";
import {
  chooseOrg,
  findSession,
  normalizeSessionId,
  parseSessionMeta,
  readSessions,
  type OrgCandidate,
} from "../src/sessions.ts";

const ORG_A = "414b5c5d-9cbb-4754-8647-e0b967072423";
const ORG_B = "ca0ad706-6476-46fd-bc9f-a252f22e041a";
const SESSION = "local_81d31fdc-abfe-4a8f-b60c-f938da388636";

function org(orgUuid: string, sessionCount: number): OrgCandidate {
  return { orgUuid, dir: `/tmp/${orgUuid}`, sessionCount };
}

test("chooseOrg 选用唯一有会话的组织", () => {
  const choice = chooseOrg([org(ORG_A, 42), org(ORG_B, 0)]);
  assert.equal(choice.ok, true);
  if (choice.ok) assert.equal(choice.org.orgUuid, ORG_A);
});

test("chooseOrg 在多个组织都有会话时要求明确指定", () => {
  const choice = chooseOrg([org(ORG_A, 2), org(ORG_B, 3)]);
  assert.equal(choice.ok, false);
  if (!choice.ok) assert.equal(choice.reason, "ambiguous");
});

test("chooseOrg 没有会话时使用唯一的组织目录", () => {
  const choice = chooseOrg([org(ORG_B, 0)]);
  assert.equal(choice.ok, true);
  if (choice.ok) assert.equal(choice.org.orgUuid, ORG_B);
});

test("chooseOrg 接受显式组织 UUID", () => {
  const choice = chooseOrg([org(ORG_A, 1), org(ORG_B, 4)], ORG_A);
  assert.equal(choice.ok, true);
  if (choice.ok) assert.equal(choice.org.sessionCount, 1);
});

test("normalizeSessionId 接受裸 UUID 和文件名", () => {
  const bare = SESSION.slice("local_".length);
  assert.equal(normalizeSessionId(bare), SESSION);
  assert.equal(normalizeSessionId(`${SESSION}.json`), SESSION);
  assert.equal(normalizeSessionId("../local_x"), null);
});

test("parseSessionMeta 读取标题和正文 ID", () => {
  const parsed = parseSessionMeta(`/tmp/${SESSION}.json`, {
    title: "生产数据导入失败行分析",
    cwd: "/Users/nicholas/code/ujoy",
    lastActivityAt: 1792329102972,
    cliSessionId: "c79590cf-36cb-4595-89fc-d86552aa579c",
    isArchived: false,
  });
  assert.ok(!("error" in parsed));
  if (!("error" in parsed)) {
    assert.equal(parsed.title, "生产数据导入失败行分析");
    assert.equal(parsed.cliSessionId, "c79590cf-36cb-4595-89fc-d86552aa579c");
  }
});

test("readSessions 按最近活动时间倒序", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-focus-"));
  const older = "local_11111111-1111-4111-8111-111111111111";
  const newer = "local_22222222-2222-4222-8222-222222222222";
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${older}.json`),
    JSON.stringify({ title: "旧", lastActivityAt: 10, cwd: "/work/old" }),
  );
  await writeFile(
    path.join(dir, `${newer}.json`),
    JSON.stringify({ title: "新", lastActivityAt: 20, cwd: "/work/new" }),
  );
  await writeFile(path.join(dir, "scheduled-tasks.json"), "{}");
  const { sessions } = await readSessions(dir);
  assert.deepEqual(
    sessions.map((session) => session.sessionId),
    [newer, older],
  );
  assert.equal(findSession(sessions, newer.slice("local_".length))?.title, "新");
});

test("formatShanghai 使用上海时区", () => {
  assert.match(formatShanghai(1792329102972), /2026/);
  assert.match(formatShanghai(1792329102972), /21:11/);
});
