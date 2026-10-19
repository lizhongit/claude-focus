import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopError } from "../src/desktop/errors.ts";
import { setLocale } from "../src/i18n.ts";

setLocale("zh");
import { formatPlanLabel, planFromBootstrap } from "../src/desktop/plan.ts";
import {
  emailFromBootstrap,
  readAccountSnapshot,
  summarizeUsage,
} from "../src/desktop/usage.ts";
import { ORG_A, PASSWORD, jsonResponse, writeCookieDb } from "./support/desktop-fixture.ts";

test("只取出邮箱和额度，不保留响应里的其它字段", () => {
  assert.equal(
    emailFromBootstrap({
      account: { email_address: "a@example.com", intercom_user_jwt: "secret-jwt" },
    }),
    "a@example.com",
  );
  const usage = summarizeUsage({
    five_hour: { utilization: 81, resets_at: "2026-10-19T07:19:59.000Z" },
    seven_day: { utilization: 11, resets_at: "2026-10-24T19:59:59.000Z" },
    private_token: "should-not-leak",
  });
  assert.equal(usage.fiveHour?.utilization, 81);
  assert.equal(usage.sevenDay?.utilization, 11);
  assert.equal(JSON.stringify(usage).includes("should-not-leak"), false);
  const plan = planFromBootstrap(
    {
      account: {
        intercom_user_jwt: "secret-jwt",
        memberships: [
          {
            organization: {
              uuid: "11111111-1111-4111-8111-111111111111",
              capabilities: ["chat", "claude_pro"],
              rate_limit_tier: "default_claude_ai",
            },
          },
          {
            organization: {
              uuid: ORG_A,
              capabilities: ["chat", "claude_max"],
              rate_limit_tier: "default_claude_max_5x",
              raven_type: "should-not-leak",
            },
          },
        ],
      },
    },
    ORG_A,
  );
  assert.equal(plan, "max_5x");
  assert.equal(formatPlanLabel(plan), "Max 5x");
  assert.equal(formatPlanLabel("free"), "Free");
  assert.equal(formatPlanLabel(null), "—");
  assert.equal(
    planFromBootstrap(
      {
        account: {
          memberships: [
            {
              organization: {
                uuid: ORG_A,
                capabilities: ["chat", "raven"],
                raven_type: "enterprise",
              },
            },
          ],
        },
      },
      null,
    ),
    "enterprise",
  );
  assert.equal(JSON.stringify(plan).includes("should-not-leak"), false);
});

test("用量请求失败时错误里没有 cookie", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cfocus-usage-"));
  const file = path.join(root, "Cookies");
  await writeCookieDb(file, PASSWORD, [
    {
      name: "sessionKey",
      host: ".claude.ai",
      value: "sk-ant-test-a",
      expires: new Date("2026-11-16T03:33:00.000Z"),
    },
    {
      name: "lastActiveOrg",
      host: "claude.ai",
      value: ORG_A,
      expires: new Date("2026-12-21T00:00:00.000Z"),
    },
  ]);
  await assert.rejects(
    () =>
      readAccountSnapshot({
        cookiePath: file,
        password: PASSWORD,
        knownOrganizationUuid: null,
        fetchImpl: async () => jsonResponse("no", 403),
      }),
    (error: unknown) => {
      assert.ok(error instanceof DesktopError);
      assert.equal(error.message, "claude.ai 返回 403");
      assert.equal(error.message.includes("sk-ant"), false);
      return true;
    },
  );
});
