import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import path from "node:path";
import test from "node:test";
import { ConfigError } from "../src/config.ts";
import { parseArgs } from "../src/cli.ts";
import { localeFromEnv, setLocale } from "../src/i18n.ts";

setLocale("zh");

const execFileAsync = promisify(execFile);
const project = path.resolve(import.meta.dirname, "..");

test("account 和 switch 解析成独立命令", () => {
  const init = parseArgs(["account", "init", "--yes"]);
  assert.equal(init.command, "account");
  assert.equal(init.subcommand, "init");
  assert.equal(init.flags.yes, true);

  const usage = parseArgs(["account", "usage", "a@example.com"]);
  assert.equal(usage.subcommand, "usage");
  assert.equal(usage.email, "a@example.com");

  const listed = parseArgs(["account", "list", "--usage"]);
  assert.equal(listed.flags.usage, true);

  const sessions = parseArgs(["list", "a@example.com", "--limit", "5"]);
  assert.equal(sessions.command, "list");
  assert.equal(sessions.email, "a@example.com");
  assert.equal(sessions.flags.limit, 5);
  assert.equal(parseArgs(["list"]).flags.limit, undefined);
  assert.throws(() => parseArgs(["list", "--limit", "0"]), ConfigError);
  assert.throws(() => parseArgs(["list", "--limit", "20.5"]), ConfigError);

  const switched = parseArgs([
    "switch",
    "--to",
    "b@example.com",
    "--session",
    "81d31fdc-abfe-4a8f-b60c-f938da388636",
    "--yes",
  ]);
  assert.equal(switched.command, "switch");
  assert.equal(switched.flags.to, "b@example.com");
  assert.deepEqual(switched.flags.sessions, ["81d31fdc-abfe-4a8f-b60c-f938da388636"]);

  assert.throws(() => parseArgs(["account"]), ConfigError);
  assert.throws(() => parseArgs(["switch", "extra"]), ConfigError);
});

test("从符号链接启动时仍会执行命令", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cfocus-link-"));
  const link = path.join(root, "cfocus-cli.ts");
  await symlink(path.join(project, "src/cli.ts"), link);
  const { stdout } = await execFileAsync(process.execPath, [link, "--help"]);
  assert.match(stdout, /account init/);
});

test("帮助包含账号切换，并且不会碰 Desktop 数据", async () => {
  const { stdout } = await execFileAsync("node", ["src/cli.ts", "--help"], {
    cwd: project,
    env: { ...process.env, CFOCUS_LANG: "zh" },
  });
  assert.match(stdout, /account init/);
  assert.match(stdout, /account add/);
  assert.match(stdout, /switch --to/);
  assert.match(stdout, /不写盘/);
});

test("--lang en 覆盖系统语言", async () => {
  const { stdout } = await execFileAsync("node", ["src/cli.ts", "--lang", "en", "--help"], {
    cwd: project,
    env: { ...process.env, CFOCUS_LANG: "zh", LANG: "zh_CN.UTF-8" },
  });
  assert.match(stdout, /nothing is written/);
  assert.match(stdout, /--lang <en\|zh>/);
  assert.equal(stdout.includes("不写盘"), false);
});

test("语言优先看 CFOCUS_LANG，其次看 LANG", () => {
  assert.equal(localeFromEnv({ CFOCUS_LANG: "en", LANG: "zh_CN.UTF-8" }), "en");
  assert.equal(localeFromEnv({ CFOCUS_LANG: "english" }), "en");
  assert.equal(localeFromEnv({ CFOCUS_LANG: "zh-CN", LANG: "en_US.UTF-8" }), "zh");
  assert.equal(localeFromEnv({ LANG: "zh_CN.UTF-8" }), "zh");
  assert.equal(localeFromEnv({ LC_ALL: "zh_TW.UTF-8", LANG: "en_US.UTF-8" }), "zh");
  assert.equal(localeFromEnv({ LANG: "en_US.UTF-8" }), "en");
  assert.equal(localeFromEnv({}), "en");
  assert.equal(parseArgs(["--lang", "en", "accounts"]).flags.lang, "en");
  assert.throws(() => parseArgs(["--lang", "fr"]), ConfigError);
});
