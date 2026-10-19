import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ConfigError,
  createInitialConfig,
  parseConfig,
  readCliOauthIdentity,
} from "../src/config.ts";

const UUID_A = "71f17eac-25e9-48b9-8b63-c05b22c21f86";
const UUID_B = "bcb99ed5-923e-43f6-ba7f-6a68eaef9447";

test("parseConfig 拒绝重复邮箱", () => {
  assert.throws(
    () =>
      parseConfig(
        {
          accounts: [
            { email: "a@example.com", accountUuid: UUID_A },
            { email: "A@example.com", accountUuid: UUID_B },
          ],
        },
        "/sessions",
      ),
    ConfigError,
  );
});

test("createInitialConfig 用命令行当前登录填写对应邮箱", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claude-focus-config-"));
  const sessionsRoot = path.join(root, "sessions");
  await mkdir(path.join(sessionsRoot, UUID_A), { recursive: true });
  await mkdir(path.join(sessionsRoot, UUID_B), { recursive: true });
  const claudeJsonPath = path.join(root, ".claude.json");
  await writeFile(
    claudeJsonPath,
    JSON.stringify({
      oauthAccount: {
        emailAddress: "lizhongit@gmail.com",
        accountUuid: UUID_A,
        accessToken: "do-not-copy",
      },
    }),
  );
  const identity = await readCliOauthIdentity(claudeJsonPath);
  assert.equal(identity?.email, "lizhongit@gmail.com");
  assert.equal(identity && "accessToken" in identity, false);
  const config = await createInitialConfig({
    configPath: path.join(root, "accounts.json"),
    sessionsRoot,
    claudeJsonPath,
  });
  assert.equal(
    config.accounts.find((account) => account.accountUuid === UUID_A)?.email,
    "lizhongit@gmail.com",
  );
  assert.equal(
    config.accounts.find((account) => account.accountUuid === UUID_B)?.email,
    "",
  );
});
