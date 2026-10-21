import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionMeta } from "../src/sessions.ts";
import { applyCopies, planCopies } from "../src/sync.ts";

function session(dir: string, id: string, title: string): SessionMeta {
  return {
    sessionId: id,
    fileName: `${id}.json`,
    filePath: path.join(dir, `${id}.json`),
    title,
    cwd: "/work/app",
    lastActivityAt: 1,
    createdAt: 1,
    isArchived: false,
    cliSessionId: "c79590cf-36cb-4595-89fc-d86552aa579c",
    childSessionIds: [],
  };
}

test("planCopies 默认跳过已存在的目标文件", () => {
  const source = session("/src", "local_81d31fdc-abfe-4a8f-b60c-f938da388636", "甲");
  const plans = planCopies({
    sessions: [source],
    destDir: "/dst",
    overwrite: false,
    destExists: () => true,
  });
  assert.equal(plans[0]?.action, "skip-exists");
  assert.equal(
    plans[0]?.destPath,
    "/dst/local_81d31fdc-abfe-4a8f-b60c-f938da388636.json",
  );
});

test("applyCopies 预览时不写文件，执行时只复制索引", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claude-focus-sync-"));
  const sourceDir = path.join(root, "source");
  const destDir = path.join(root, "dest");
  await mkdir(sourceDir);
  const id = "local_81d31fdc-abfe-4a8f-b60c-f938da388636";
  const body = JSON.stringify({ title: "甲", cliSessionId: "abc" });
  await writeFile(path.join(sourceDir, `${id}.json`), body);
  const meta = session(sourceDir, id, "甲");
  const plans = planCopies({
    sessions: [meta],
    destDir,
    overwrite: false,
    destExists: () => false,
  });
  await applyCopies(plans, true);
  assert.equal(existsSync(path.join(destDir, `${id}.json`)), false);
  const result = await applyCopies(plans, false);
  assert.deepEqual(result, { copied: 1, skipped: 0, overwritten: 0 });
  assert.equal(await readFile(path.join(destDir, `${id}.json`), "utf8"), body);
  const again = planCopies({
    sessions: [meta],
    destDir,
    overwrite: false,
    destExists: existsSync,
  });
  const second = await applyCopies(again, false);
  assert.equal(second.skipped, 1);
  assert.equal(second.copied, 0);
});
