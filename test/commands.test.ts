import assert from "node:assert/strict";
import { lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  addAccount,
  cancelAdd,
  initDesktop,
  listAccounts,
  showUsage,
  switchAccount,
} from "../src/desktop/commands.ts";
import { DesktopError } from "../src/desktop/errors.ts";
import { loadState, parseState, saveState } from "../src/desktop/state.ts";
import { setLocale } from "../src/i18n.ts";

setLocale("zh");
import {
  ORG_A,
  ORG_B,
  PASSWORD,
  UUID_A,
  UUID_B,
  fakeDesktop,
  jsonResponse,
  seedLiveAccount,
  tempDesktop,
  writeCookieDb,
} from "./support/desktop-fixture.ts";

const SESSION_ID = "81d31fdc-abfe-4a8f-b60c-f938da388636";
const SECRETS = [
  "sk-ant-test-a",
  "sk-ant-test-b",
  "secret-jwt",
  "should-not-leak",
  PASSWORD,
  "djEwSECRET",
  "clearance-a",
];

function assertNoSecrets(text: string): void {
  for (const secret of SECRETS) {
    assert.equal(text.includes(secret), false, secret);
  }
}

function scriptedFetch(emails: string[]) {
  let bootstrap = 0;
  return async (url: string) => {
    if (url.includes("/bootstrap")) {
      const email = emails[bootstrap] ?? emails[emails.length - 1] ?? "a@example.com";
      bootstrap += 1;
      return jsonResponse({
        account: {
          email_address: email,
          intercom_user_jwt: "secret-jwt",
          memberships: [
            {
              organization: {
                uuid: ORG_A,
                capabilities: ["chat", "claude_pro"],
                rate_limit_tier: "default_claude_ai",
              },
            },
          ],
        },
      });
    }
    if (url.includes("/usage")) {
      return jsonResponse({
        five_hour: { utilization: 81, resets_at: "2026-10-19T07:19:59.000Z" },
        seven_day: { utilization: 11, resets_at: "2026-10-24T19:59:59.000Z" },
        private_token: "should-not-leak",
      });
    }
    return jsonResponse({ missing: true }, 404);
  };
}

test("初始化备份、共享链接，并只在内存里识别邮箱", async () => {
  const { root, paths } = await tempDesktop();
  await seedLiveAccount(paths.claudeDataDir);
  const fake = fakeDesktop({ root, paths, fetchImpl: scriptedFetch(["a@example.com"]) });
  await initDesktop(fake.runtime);
  const state = await loadState(paths.statePath);
  assert.equal(state?.currentAccountUuid, UUID_A);
  assert.equal(state?.accounts[UUID_A]?.email, "a@example.com");
  assert.equal(state?.accounts[UUID_A]?.organizationUuid, ORG_A);
  assert.equal(state?.accounts[UUID_A]?.plan, "pro");
  const stateText = await readFile(paths.statePath, "utf8");
  assertNoSecrets(stateText);
  assertNoSecrets(fake.logs.join("\n"));
  assert.equal((await stat(paths.statePath)).mode & 0o777, 0o600);
  const backupCache = await lstat(path.join(paths.backupDir, "Cache"));
  assert.equal(backupCache.isSymbolicLink(), false);
  assert.equal(
    await readFile(path.join(paths.backupDir, "Cache", "keep.bin"), "utf8"),
    "cache-body",
  );
  const liveCache = await lstat(path.join(paths.claudeDataDir, "Cache"));
  assert.equal(liveCache.isSymbolicLink(), true);
  assert.equal(fake.launches.count, 1);
  assert.equal(fake.passwordReads.count, 1);
  const accounts = JSON.parse(await readFile(fake.runtime.configPath, "utf8")) as {
    accounts: { email: string }[];
  };
  assert.equal(accounts.accounts[0]?.email, "a@example.com");
});

test("已有备份时不再复制第二份", async () => {
  const { root, paths } = await tempDesktop();
  await seedLiveAccount(paths.claudeDataDir);
  await mkdir(paths.backupDir, { recursive: true });
  await writeFile(path.join(paths.backupDir, "MARKER"), "keep");
  const fake = fakeDesktop({ root, paths, fetchImpl: scriptedFetch(["a@example.com"]) });
  await initDesktop(fake.runtime);
  assert.equal(await readFile(path.join(paths.backupDir, "MARKER"), "utf8"), "keep");
  await assert.rejects(lstat(path.join(paths.backupDir, "Cache")));
  assert.match(fake.logs.join("\n"), /备份已存在/);
});

test("Desktop 不退出时不移动文件", async () => {
  const { root, paths } = await tempDesktop();
  await seedLiveAccount(paths.claudeDataDir);
  const fake = fakeDesktop({ root, paths, fetchImpl: scriptedFetch(["a@example.com"]) });
  fake.running.value = true;
  fake.runtime.quit = async () => {
    fake.quits.count += 1;
  };
  await assert.rejects(() => initDesktop(fake.runtime), /没有退出/);
  const cache = await lstat(path.join(paths.claudeDataDir, "Cache"));
  assert.equal(cache.isDirectory(), true);
  assert.equal(cache.isSymbolicLink(), false);
  assert.equal(await loadState(paths.statePath), null);
});

test("非交互且没有 --yes 时不退出", async () => {
  const { root, paths } = await tempDesktop();
  await seedLiveAccount(paths.claudeDataDir);
  const fake = fakeDesktop({
    root,
    paths,
    fetchImpl: scriptedFetch(["a@example.com"]),
    yes: false,
  });
  fake.running.value = true;
  await assert.rejects(() => initDesktop(fake.runtime), /--yes/);
  assert.equal(fake.quits.count, 0);
});

test("添加账号会打开空白登录并识别新邮箱", async () => {
  const { root, paths } = await tempDesktop();
  await seedLiveAccount(paths.claudeDataDir);
  const fake = fakeDesktop({
    root,
    paths,
    fetchImpl: scriptedFetch(["a@example.com", "b@example.com"]),
  });
  const started = fake.now.value;
  fake.runtime.sleep = async (ms) => {
    fake.now.value += ms;
    if (fake.now.value >= started + 1000) {
      await writeFile(
        path.join(paths.claudeDataDir, "config.json"),
        JSON.stringify({ lastKnownAccountUuid: UUID_B }),
      );
      await writeCookieDb(path.join(paths.claudeDataDir, "Cookies"), PASSWORD, [
        {
          name: "sessionKey",
          host: ".claude.ai",
          value: "sk-ant-test-b",
          expires: new Date("2026-11-16T03:33:00.000Z"),
        },
        {
          name: "lastActiveOrg",
          host: "claude.ai",
          value: ORG_B,
          expires: new Date("2026-12-21T00:00:00.000Z"),
        },
      ]);
    }
  };
  await addAccount(fake.runtime);
  const state = await loadState(paths.statePath);
  assert.equal(state?.currentAccountUuid, UUID_B);
  assert.equal(state?.pendingPreviousUuid, null);
  assert.equal(state?.accounts[UUID_B]?.email, "b@example.com");
  assert.equal(await readFile(path.join(paths.profilesDir, UUID_A, "who.txt"), "utf8"), "a");
  assert.equal(
    JSON.parse(await readFile(path.join(paths.claudeDataDir, "config.json"), "utf8"))
      .lastKnownAccountUuid,
    UUID_B,
  );
  const liveCache = await lstat(path.join(paths.claudeDataDir, "Cache"));
  assert.equal(liveCache.isSymbolicLink(), true);
  assert.equal(
    await readFile(path.join(paths.sharedDir, "Cache", "keep.bin"), "utf8"),
    "cache-body",
  );
  assertNoSecrets(JSON.stringify(state));
  assertNoSecrets(fake.logs.join("\n"));
  assert.match(fake.logs.join("\n"), /b@example.com/);
});

test("新账号邮箱冲突时恢复上一个账号", async () => {
  const { root, paths } = await tempDesktop();
  await seedLiveAccount(paths.claudeDataDir);
  const fake = fakeDesktop({
    root,
    paths,
    fetchImpl: scriptedFetch(["a@example.com", "a@example.com"]),
  });
  const started = fake.now.value;
  let wrote = false;
  fake.runtime.sleep = async (ms) => {
    fake.now.value += ms;
    if (!wrote && fake.now.value >= started + 1000) {
      wrote = true;
      await writeFile(
        path.join(paths.claudeDataDir, "config.json"),
        JSON.stringify({ lastKnownAccountUuid: UUID_B }),
      );
      await writeCookieDb(path.join(paths.claudeDataDir, "Cookies"), PASSWORD, [
        {
          name: "sessionKey",
          host: ".claude.ai",
          value: "sk-ant-test-b",
          expires: new Date("2026-11-16T03:33:00.000Z"),
        },
      ]);
    }
  };
  await assert.rejects(() => addAccount(fake.runtime), /已经属于另一个账号/);
  const state = await loadState(paths.statePath);
  assert.equal(state?.currentAccountUuid, UUID_A);
  assert.equal(state?.pendingPreviousUuid, null);
  assert.equal(state?.accounts[UUID_B], undefined);
  assert.equal(await readFile(path.join(paths.claudeDataDir, "who.txt"), "utf8"), "a");
});

test("取消未完成的登录会恢复上一个账号，并留下共享文件", async () => {
  const { root, paths } = await tempDesktop();
  await seedLiveAccount(paths.claudeDataDir);
  const fake = fakeDesktop({ root, paths, fetchImpl: scriptedFetch(["a@example.com"]) });
  fake.runtime.loginTimeoutMs = 0;
  await addAccount(fake.runtime);
  assert.match(fake.logs.join("\n"), /account adopt/);
  await writeFile(path.join(paths.claudeDataDir, "partial.txt"), "partial");
  await cancelAdd(fake.runtime);
  assert.equal(await readFile(path.join(paths.claudeDataDir, "who.txt"), "utf8"), "a");
  await assert.rejects(lstat(path.join(paths.claudeDataDir, "partial.txt")));
  assert.equal(
    await readFile(path.join(paths.sharedDir, "Cache", "keep.bin"), "utf8"),
    "cache-body",
  );
  const state = await loadState(paths.statePath);
  assert.equal(state?.currentAccountUuid, UUID_A);
  assert.equal(state?.pendingPreviousUuid, null);
});

test("新登录已经有账号时不能取消", async () => {
  const { root, paths } = await tempDesktop();
  await seedLiveAccount(paths.claudeDataDir);
  const fake = fakeDesktop({ root, paths, fetchImpl: scriptedFetch(["a@example.com"]) });
  fake.runtime.loginTimeoutMs = 0;
  await addAccount(fake.runtime);
  await writeFile(
    path.join(paths.claudeDataDir, "config.json"),
    JSON.stringify({ lastKnownAccountUuid: UUID_B }),
  );
  await assert.rejects(() => cancelAdd(fake.runtime), /account adopt/);
  const state = await loadState(paths.statePath);
  assert.equal(state?.pendingPreviousUuid, UUID_A);
});

test("一次切换同时复制会话索引，并且只重启一轮", async () => {
  const { root, paths } = await tempDesktop();
  await seedLiveAccount(paths.claudeDataDir);
  const fake = fakeDesktop({ root, paths, fetchImpl: scriptedFetch(["a@example.com"]) });
  await initDesktop(fake.runtime);
  const sessionName = `local_${SESSION_ID}.json`;
  await writeFile(
    path.join(paths.claudeDataDir, "claude-code-sessions", UUID_A, ORG_A, sessionName),
    JSON.stringify({ title: "导入分析", cwd: "/work/ujoy" }),
  );
  await mkdir(
    path.join(paths.claudeDataDir, "claude-code-sessions", UUID_B, ORG_B),
    { recursive: true },
  );
  const profileB = path.join(paths.profilesDir, UUID_B);
  await mkdir(profileB, { recursive: true });
  await writeFile(path.join(profileB, "who.txt"), "b");
  await symlink(path.join(paths.sharedDir, "Cache"), path.join(profileB, "Cache"));
  const state = await loadState(paths.statePath);
  assert.ok(state);
  state.accounts[UUID_B] = {
    email: "b@example.com",
    organizationUuid: ORG_B,
    adoptedAt: "2026-10-19T00:00:00.000Z",
    plan: null,
  };
  const { saveState } = await import("../src/desktop/state.ts");
  await saveState(paths.statePath, state);
  const launchesBefore = fake.launches.count;
  const quitsBefore = fake.quits.count;
  await switchAccount(fake.runtime, {
    toEmail: "b@example.com",
    sessionIds: [SESSION_ID],
    overwrite: false,
  });
  assert.equal(fake.quits.count - quitsBefore, 1);
  assert.equal(fake.launches.count - launchesBefore, 1);
  assert.equal(await readFile(path.join(paths.claudeDataDir, "who.txt"), "utf8"), "b");
  assert.equal(
    await readFile(path.join(paths.profilesDir, UUID_A, "who.txt"), "utf8"),
    "a",
  );
  const copied = path.join(
    paths.sharedDir,
    "claude-code-sessions",
    UUID_B,
    ORG_B,
    sessionName,
  );
  const body = JSON.parse(await readFile(copied, "utf8")) as { title: string };
  assert.equal(body.title, "导入分析");
  const after = await loadState(paths.statePath);
  assert.equal(after?.currentAccountUuid, UUID_B);
  assert.match(fake.logs.join("\n"), /复制 1/);
});

test("切换复制会话时带上子会话，--overwrite 同时覆盖", async () => {
  const { root, paths } = await tempDesktop();
  await seedLiveAccount(paths.claudeDataDir);
  const fake = fakeDesktop({ root, paths, fetchImpl: scriptedFetch(["a@example.com"]) });
  await initDesktop(fake.runtime);
  const parentName = `local_${SESSION_ID}.json`;
  const childId = "22222222-2222-4222-8222-222222222222";
  const childName = `local_${childId}.json`;
  const sourceDir = path.join(paths.claudeDataDir, "claude-code-sessions", UUID_A, ORG_A);
  await writeFile(
    path.join(sourceDir, parentName),
    JSON.stringify({
      title: "主会话",
      sideSessionNotes: [{ sessionId: `local_${childId}` }],
    }),
  );
  await writeFile(path.join(sourceDir, childName), JSON.stringify({ title: "子会话" }));
  const destDir = path.join(paths.sharedDir, "claude-code-sessions", UUID_B, ORG_B);
  await mkdir(destDir, { recursive: true });
  await writeFile(path.join(destDir, parentName), JSON.stringify({ title: "旧主会话" }));
  await writeFile(path.join(destDir, childName), JSON.stringify({ title: "旧子会话" }));
  const profileB = path.join(paths.profilesDir, UUID_B);
  await mkdir(profileB, { recursive: true });
  await writeFile(path.join(profileB, "who.txt"), "b");
  await symlink(path.join(paths.sharedDir, "Cache"), path.join(profileB, "Cache"));
  const state = await loadState(paths.statePath);
  assert.ok(state);
  state.accounts[UUID_B] = {
    email: "b@example.com",
    organizationUuid: ORG_B,
    adoptedAt: "2026-10-19T00:00:00.000Z",
    plan: null,
  };
  const { saveState } = await import("../src/desktop/state.ts");
  await saveState(paths.statePath, state);
  await switchAccount(fake.runtime, {
    toEmail: "b@example.com",
    sessionIds: [SESSION_ID],
    overwrite: true,
  });
  const parent = JSON.parse(await readFile(path.join(destDir, parentName), "utf8")) as { title: string };
  const child = JSON.parse(await readFile(path.join(destDir, childName), "utf8")) as { title: string };
  assert.equal(parent.title, "主会话");
  assert.equal(child.title, "子会话");
  assert.match(fake.logs.join("\n"), /一并带上 1 个关联子会话/);
  assert.match(fake.logs.join("\n"), /覆盖 2/);
});

test("Desktop 原本关闭时，切换后保持关闭", async () => {
  const { root, paths } = await tempDesktop();
  await seedLiveAccount(paths.claudeDataDir);
  const fake = fakeDesktop({ root, paths, fetchImpl: scriptedFetch(["a@example.com"]) });
  await initDesktop(fake.runtime);
  const profileB = path.join(paths.profilesDir, UUID_B);
  await mkdir(profileB, { recursive: true });
  await writeFile(path.join(profileB, "who.txt"), "b");
  const state = await loadState(paths.statePath);
  assert.ok(state);
  state.accounts[UUID_B] = {
    email: "b@example.com",
    organizationUuid: ORG_B,
    adoptedAt: "2026-10-19T00:00:00.000Z",
    plan: null,
  };
  const { saveState } = await import("../src/desktop/state.ts");
  await saveState(paths.statePath, state);
  fake.running.value = false;
  const launchesBefore = fake.launches.count;
  const quitsBefore = fake.quits.count;
  await switchAccount(fake.runtime, {
    toEmail: "b@example.com",
    sessionIds: [],
    overwrite: false,
  });
  assert.equal(fake.quits.count, quitsBefore);
  assert.equal(fake.launches.count, launchesBefore);
  assert.equal(fake.running.value, false);
  assert.equal(await readFile(path.join(paths.claudeDataDir, "who.txt"), "utf8"), "b");
  assert.equal((await loadState(paths.statePath))?.currentAccountUuid, UUID_B);
  assert.match(fake.logs.join("\n"), /保持关闭/);
});

test("account list 默认不读钥匙串，--usage 只打印额度", async () => {
  const { root, paths } = await tempDesktop();
  await seedLiveAccount(paths.claudeDataDir);
  const fake = fakeDesktop({ root, paths, fetchImpl: scriptedFetch(["a@example.com"]) });
  await initDesktop(fake.runtime);
  const readsAfterInit = fake.passwordReads.count;
  await listAccounts(fake.runtime, false);
  assert.equal(fake.passwordReads.count, readsAfterInit);
  const cached = fake.logs.at(-1) ?? "";
  assert.match(cached, /当前/);
  assert.match(cached, /a@example.com/);
  assert.match(cached, /Pro/);
  assert.match(cached, /2026-11-16 11:33/);
  assert.equal(cached.includes("81%"), false);
  const stored = await loadState(paths.statePath);
  assert.ok(stored);
  const record = stored.accounts[UUID_A];
  assert.ok(record);
  record.plan = null;
  await saveState(paths.statePath, stored);
  await listAccounts(fake.runtime, false);
  assert.equal(fake.passwordReads.count, readsAfterInit + 1);
  const filled = fake.logs.at(-1) ?? "";
  assert.match(filled, /Pro/);
  assert.equal(filled.includes("81%"), false);
  assert.equal((await loadState(paths.statePath))?.accounts[UUID_A]?.plan, "pro");
  await listAccounts(fake.runtime, false);
  assert.equal(fake.passwordReads.count, readsAfterInit + 1);
  await showUsage(fake.runtime);
  assert.equal(fake.passwordReads.count, readsAfterInit + 2);
  assert.match(fake.logs.at(-1) ?? "", /81%/);
  assertNoSecrets(fake.logs.join("\n"));
});

test("旧 state.json 没有档位时按空档位读取", () => {
  const state = parseState({
    version: 1,
    currentAccountUuid: UUID_A,
    pendingPreviousUuid: null,
    accounts: {
      [UUID_A]: {
        email: "a@example.com",
        organizationUuid: ORG_A,
        adoptedAt: "2026-10-19T00:00:00.000Z",
        plan: "not-a-plan",
      },
    },
  });
  assert.equal(state.accounts[UUID_A]?.plan, null);
});
