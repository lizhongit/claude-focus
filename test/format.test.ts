import assert from "node:assert/strict";
import test from "node:test";
import { displayWidth, renderAccountTable, renderSessionTable } from "../src/format.ts";
import { setLocale } from "../src/i18n.ts";

setLocale("zh");

test("中文按两个显示宽度计算", () => {
  assert.equal(displayWidth("在用"), 4);
  assert.equal(displayWidth("ujoy"), 4);
});

test("会话表格按列对齐，并给会话 ID 单独一行", () => {
  const table = renderSessionTable({
    email: "a@example.com",
    accountUuid: "71f17eac-25e9-48b9-8b63-c05b22c21f86",
    orgUuid: "414b5c5d-9cbb-4754-8647-e0b967072423",
    color: false,
    columns: 100,
    rows: [
      {
        time: "2026-10-18 21:11",
        archived: false,
        project: "ujoy",
        title: "生产数据导入失败行分析",
        sessionId: "local_81d31fdc-abfe-4a8f-b60c-f938da388636",
      },
      {
        time: "2026-10-16 15:26",
        archived: true,
        project: "ujoy",
        title: "已归档的会话",
        sessionId: "local_11111111-1111-4111-8111-111111111111",
      },
    ],
  });
  assert.equal(table.includes("\u001b["), false);
  assert.match(table, /时间\s+状态\s+项目\s+标题/);
  assert.match(table, /在用\s+ujoy\s+生产数据导入失败行分析/);
  assert.match(table, /归档\s+ujoy\s+已归档的会话/);
  const idLine = table
    .split("\n")
    .find((line) => line.includes("local_81d31fdc-abfe-4a8f-b60c-f938da388636"));
  assert.ok(idLine);
  assert.match(idLine ?? "", /^\s+local_81d31fdc/);
});

test("账号表格对齐，额度按用量上色", () => {
  const row = {
    current: true,
    email: "a@example.com",
    accountUuid: "71f17eac-25e9-48b9-8b63-c05b22c21f86",
    organizationUuid: "414b5c5d-9cbb-4754-8647-e0b967072423",
    plan: "pro",
    expiresAt: Date.parse("2026-11-16T03:33:00.000Z"),
    expired: false,
    expiryNote: null,
    note: null,
    usage: { fiveHour: 81, sevenDay: 11, sevenDaySonnet: 96, note: null },
  };
  const plain = renderAccountTable({ rows: [row], color: false, columns: 120 });
  assert.equal(plain.includes("\u001b["), false);
  assert.match(plain, /状态\s+邮箱\s+档位\s+登录到期\s+5 小时\s+7 天\s+Sonnet/);
  assert.match(plain, /当前\s+a@example.com\s+Pro\s+2026-11-16 11:33\s+81%\s+11%\s+96%/);
  const idLine = plain.split("\n").find((line) => line.includes(row.accountUuid));
  assert.match(idLine ?? "", /^\s+71f17eac/);

  const colored = renderAccountTable({ rows: [row], color: true, columns: 120 });
  assert.match(colored, /\u001b\[1;32m当前/);
  assert.match(colored, /\u001b\[1;36ma@example.com/);
  assert.match(colored, /\u001b\[36mPro/);
  assert.match(colored, /\u001b\[33m81%/);
  assert.match(colored, /\u001b\[32m11%/);
  assert.match(colored, /\u001b\[31m96%/);
});

test("终端颜色只包在文字外面", () => {
  const table = renderSessionTable({
    email: "a@example.com",
    accountUuid: "71f17eac-25e9-48b9-8b63-c05b22c21f86",
    orgUuid: "414b5c5d-9cbb-4754-8647-e0b967072423",
    color: true,
    columns: 100,
    rows: [
      {
        time: "2026-10-18 21:11",
        archived: false,
        project: "ujoy",
        title: "标题",
        sessionId: "local_81d31fdc-abfe-4a8f-b60c-f938da388636",
      },
    ],
  });
  assert.match(table, /\u001b\[32m在用/);
  assert.match(table, /\u001b\[34mujoy/);
  assert.match(table, /\u001b\[1m标题/);
});

test("英文表格使用英文表头", () => {
  const sessions = renderSessionTable({
    email: "a@example.com",
    accountUuid: "71f17eac-25e9-48b9-8b63-c05b22c21f86",
    orgUuid: "414b5c5d-9cbb-4754-8647-e0b967072423",
    color: false,
    columns: 100,
    locale: "en",
    rows: [
      {
        time: "2026-10-18 21:11",
        archived: false,
        project: "ujoy",
        title: "import",
        sessionId: "local_81d31fdc-abfe-4a8f-b60c-f938da388636",
      },
      {
        time: "2026-10-16 15:26",
        archived: true,
        project: "ujoy",
        title: "old",
        sessionId: "local_11111111-1111-4111-8111-111111111111",
      },
    ],
  });
  assert.match(sessions, /Time\s+Status\s+Project\s+Title/);
  assert.match(sessions, /Active\s+ujoy\s+import/);
  assert.match(sessions, /Archived\s+ujoy\s+old/);
  assert.match(sessions, /2 sessions/);

  const accounts = renderAccountTable({
    color: false,
    columns: 120,
    locale: "en",
    rows: [
      {
        current: true,
        email: "a@example.com",
        accountUuid: "71f17eac-25e9-48b9-8b63-c05b22c21f86",
        organizationUuid: "414b5c5d-9cbb-4754-8647-e0b967072423",
        plan: "pro",
        expiresAt: Date.parse("2026-11-16T03:33:00.000Z"),
        expired: false,
        expiryNote: null,
        note: null,
        usage: { fiveHour: 81, sevenDay: 11, sevenDaySonnet: 96, note: null },
      },
      {
        current: false,
        email: "b@example.com",
        accountUuid: "bcb99ed5-923e-43f6-ba7f-6a68eaef9447",
        organizationUuid: null,
        plan: "max_5x",
        expiresAt: null,
        expired: true,
        expiryNote: null,
        note: null,
        usage: null,
      },
    ],
  });
  assert.match(accounts, /Desktop accounts\s+2/);
  assert.match(accounts, /Status\s+Email\s+Plan\s+Login expires\s+5 hours\s+7 days\s+Sonnet/);
  assert.match(accounts, /Current\s+a@example.com\s+Pro\s+2026-11-16 11:33\s+81%\s+11%\s+96%/);
  assert.match(accounts, /Other\s+b@example.com\s+Max 5x/);
  assert.match(accounts, /org 414b5c5d-9cbb-4754-8647-e0b967072423/);
});
