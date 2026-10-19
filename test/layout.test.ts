import assert from "node:assert/strict";
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DesktopError } from "../src/desktop/errors.ts";
import {
  ensureShared,
  removeDirectoryKeepingLinkTargets,
  swapLiveProfile,
} from "../src/desktop/layout.ts";
import { SHARED_DIR_NAMES } from "../src/desktop/paths.ts";
import { setLocale } from "../src/i18n.ts";
import { UUID_A, UUID_B, tempDesktop } from "./support/desktop-fixture.ts";

setLocale("zh");

test("共享目录只搬一次，Cookies 留在账号目录", async () => {
  const { paths } = await tempDesktop();
  const live = paths.claudeDataDir;
  await mkdir(path.join(live, "Cache"), { recursive: true });
  await writeFile(path.join(live, "Cache", "keep.bin"), "cache-body");
  await writeFile(path.join(live, "Cookies"), "cookie-file");
  const first = await ensureShared(live, paths.sharedDir);
  assert.ok(first.moved.includes("Cache"));
  const link = await readlink(path.join(live, "Cache"));
  assert.equal(path.resolve(link), path.join(paths.sharedDir, "Cache"));
  assert.equal(
    await readFile(path.join(paths.sharedDir, "Cache", "keep.bin"), "utf8"),
    "cache-body",
  );
  assert.equal(await readFile(path.join(live, "Cookies"), "utf8"), "cookie-file");
  for (const name of SHARED_DIR_NAMES) {
    const stat = await lstat(path.join(live, name));
    assert.equal(stat.isSymbolicLink(), true);
  }
  const second = await ensureShared(live, paths.sharedDir);
  assert.deepEqual(second.moved, []);
});

test("账号目录和共享目录都有实体时不合并", async () => {
  const { paths } = await tempDesktop();
  await mkdir(path.join(paths.claudeDataDir, "Cache"), { recursive: true });
  await mkdir(path.join(paths.sharedDir, "Cache"), { recursive: true });
  await writeFile(path.join(paths.claudeDataDir, "Cache", "live.bin"), "live");
  await writeFile(path.join(paths.sharedDir, "Cache", "shared.bin"), "shared");
  await assert.rejects(
    () => ensureShared(paths.claudeDataDir, paths.sharedDir),
    (error: unknown) => {
      assert.ok(error instanceof DesktopError);
      assert.match(error.message, /都有实体/);
      return true;
    },
  );
  assert.equal(
    await readFile(path.join(paths.claudeDataDir, "Cache", "live.bin"), "utf8"),
    "live",
  );
  assert.equal(
    await readFile(path.join(paths.sharedDir, "Cache", "shared.bin"), "utf8"),
    "shared",
  );
});

test("删掉登录目录时不跟随符号链接", async () => {
  const { paths } = await tempDesktop();
  await mkdir(path.join(paths.claudeDataDir, "Cache"), { recursive: true });
  await writeFile(path.join(paths.claudeDataDir, "Cache", "keep.bin"), "cache-body");
  await ensureShared(paths.claudeDataDir, paths.sharedDir);
  await removeDirectoryKeepingLinkTargets(paths.claudeDataDir);
  assert.equal(
    await readFile(path.join(paths.sharedDir, "Cache", "keep.bin"), "utf8"),
    "cache-body",
  );
});

test("切换是两次重命名，共享链接仍然指向原处", async () => {
  const { paths } = await tempDesktop();
  const live = paths.claudeDataDir;
  await mkdir(path.join(live, "Cache"), { recursive: true });
  await writeFile(path.join(live, "Cache", "keep.bin"), "cache-body");
  await writeFile(path.join(live, "who.txt"), "a");
  await ensureShared(live, paths.sharedDir);
  const profileB = path.join(paths.profilesDir, UUID_B);
  await mkdir(profileB, { recursive: true });
  await writeFile(path.join(profileB, "who.txt"), "b");
  await symlink(path.join(paths.sharedDir, "Cache"), path.join(profileB, "Cache"));
  await swapLiveProfile({
    liveDir: live,
    profilesDir: paths.profilesDir,
    fromUuid: UUID_A,
    toUuid: UUID_B,
  });
  assert.equal(await readFile(path.join(live, "who.txt"), "utf8"), "b");
  assert.equal(
    await readFile(path.join(paths.profilesDir, UUID_A, "who.txt"), "utf8"),
    "a",
  );
  assert.equal(
    path.resolve(await readlink(path.join(live, "Cache"))),
    path.join(paths.sharedDir, "Cache"),
  );
  assert.equal(
    await readFile(path.join(paths.sharedDir, "Cache", "keep.bin"), "utf8"),
    "cache-body",
  );
});
