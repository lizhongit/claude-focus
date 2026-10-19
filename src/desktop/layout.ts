import { lstat, mkdir, readdir, readlink, rename, rmdir, symlink, unlink } from "node:fs/promises";
import { cp } from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import { text } from "../i18n.ts";
import { DesktopError } from "./errors.ts";
import { SHARED_DIR_NAMES, type SharedDirName } from "./paths.ts";

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

export async function ensureShared(
  liveDir: string,
  sharedDir: string,
): Promise<{ moved: SharedDirName[]; linked: SharedDirName[] }> {
  const liveStat = await lstatOrNull(liveDir);
  if (liveStat == null || !liveStat.isDirectory()) {
    throw new DesktopError(text(`Claude data directory not found: ${liveDir}`, `找不到 Claude 数据目录：${liveDir}`));
  }
  await mkdir(sharedDir, { recursive: true, mode: 0o700 });
  const moved: SharedDirName[] = [];
  const linked: SharedDirName[] = [];
  for (const name of SHARED_DIR_NAMES) {
    const source = path.join(liveDir, name);
    const dest = path.join(sharedDir, name);
    const sourceStat = await lstatOrNull(source);
    const destStat = await lstatOrNull(dest);
    if (sourceStat?.isSymbolicLink()) {
      const link = await readlink(source);
      const resolved = path.resolve(path.dirname(source), link);
      if (!samePath(resolved, dest)) {
        throw new DesktopError(
          text(`${name} already points somewhere else. Nothing changed: ${link}`, `${name} 已指向别处，没有改动：${link}`),
        );
      }
      continue;
    }
    if (sourceStat != null && !sourceStat.isDirectory()) {
      throw new DesktopError(text(`${name} is not a directory. Nothing changed`, `${name} 不是目录，没有改动`));
    }
    if (destStat?.isSymbolicLink()) {
      throw new DesktopError(text(`Shared directory ${name} must not be a symlink`, `共享目录 ${name} 不应是符号链接`));
    }
    if (destStat != null && !destStat.isDirectory()) {
      throw new DesktopError(text(`Shared directory ${name} is not a directory`, `共享目录 ${name} 不是目录`));
    }
    if (sourceStat?.isDirectory() && destStat?.isDirectory()) {
      throw new DesktopError(
        text(
          `${name} exists as a real directory in both the account directory and the shared directory. Nothing was merged.`,
          `${name} 在账号目录和共享目录里都有实体。没有合并，避免盖掉其中一边。`,
        ),
      );
    }
    if (sourceStat?.isDirectory()) {
      await rename(source, dest);
      await symlink(dest, source);
      moved.push(name);
      continue;
    }
    if (destStat == null) {
      await mkdir(dest, { recursive: true });
    }
    await symlink(dest, source);
    linked.push(name);
  }
  return { moved, linked };
}

export async function backupLiveIfMissing(
  liveDir: string,
  backupDir: string,
): Promise<"created" | "exists"> {
  const existing = await lstatOrNull(backupDir);
  if (existing != null) return "exists";
  const live = await lstatOrNull(liveDir);
  if (live == null || !live.isDirectory()) {
    throw new DesktopError(text(`Claude data directory not found: ${liveDir}`, `找不到 Claude 数据目录：${liveDir}`));
  }
  await mkdir(path.dirname(backupDir), { recursive: true, mode: 0o700 });
  await cp(liveDir, backupDir, { recursive: true, verbatimSymlinks: true });
  return "created";
}

export async function createBlankLive(
  liveDir: string,
  sharedDir: string,
): Promise<void> {
  const existing = await lstatOrNull(liveDir);
  if (existing != null) {
    throw new DesktopError(text(`Login directory already exists and was not overwritten: ${liveDir}`, `登录目录已存在，没有覆盖：${liveDir}`));
  }
  await mkdir(liveDir, { recursive: true });
  await mkdir(sharedDir, { recursive: true, mode: 0o700 });
  for (const name of SHARED_DIR_NAMES) {
    const dest = path.join(sharedDir, name);
    if ((await lstatOrNull(dest)) == null) await mkdir(dest, { recursive: true });
    await symlink(dest, path.join(liveDir, name));
  }
}

export async function parkLiveProfile(
  liveDir: string,
  profilesDir: string,
  accountUuid: string,
): Promise<string> {
  const parked = path.join(profilesDir, accountUuid);
  if ((await lstatOrNull(parked)) != null) {
    throw new DesktopError(text(`Account directory already exists and was not overwritten: ${parked}`, `账号目录已在 ${parked}，没有覆盖`));
  }
  await mkdir(profilesDir, { recursive: true, mode: 0o700 });
  await rename(liveDir, parked);
  return parked;
}

export async function restoreParkedProfile(
  liveDir: string,
  profilesDir: string,
  accountUuid: string,
): Promise<void> {
  if ((await lstatOrNull(liveDir)) != null) {
    throw new DesktopError(text(`Login directory is still present, so nothing was restored: ${liveDir}`, `登录目录还在，没有恢复：${liveDir}`));
  }
  const parked = path.join(profilesDir, accountUuid);
  if ((await lstatOrNull(parked)) == null) {
    throw new DesktopError(text(`Account directory to restore was not found: ${parked}`, `找不到要恢复的账号目录：${parked}`));
  }
  await rename(parked, liveDir);
}

export async function swapLiveProfile(options: {
  liveDir: string;
  profilesDir: string;
  fromUuid: string;
  toUuid: string;
}): Promise<void> {
  if (options.fromUuid.toLowerCase() === options.toUuid.toLowerCase()) {
    throw new DesktopError(text("The destination is already the current account", "目标就是当前账号"));
  }
  const parked = path.join(options.profilesDir, options.fromUuid);
  const incoming = path.join(options.profilesDir, options.toUuid);
  if ((await lstatOrNull(parked)) != null) {
    throw new DesktopError(text(`Previous account directory already exists and was not overwritten: ${parked}`, `原账号目录已存在，没有覆盖：${parked}`));
  }
  if ((await lstatOrNull(incoming)) == null) {
    throw new DesktopError(text(`Destination account directory not found: ${incoming}`, `找不到目标账号目录：${incoming}`));
  }
  if ((await lstatOrNull(options.liveDir)) == null) {
    throw new DesktopError(text(`Current login directory not found: ${options.liveDir}`, `找不到当前登录目录：${options.liveDir}`));
  }
  await mkdir(options.profilesDir, { recursive: true, mode: 0o700 });
  await rename(options.liveDir, parked);
  try {
    await rename(incoming, options.liveDir);
  } catch (error) {
    try {
      await rename(parked, options.liveDir);
    } catch {
      const detail = error instanceof Error ? error.message : text("rename failed", "重命名失败");
      throw new DesktopError(
        text(
          `Switch failed, and the previous account directory could not be put back. It is at ${parked}. ${detail}`,
          `切换失败，而且没能把原账号目录放回去。原目录在 ${parked}。${detail}`,
        ),
      );
    }
    throw new DesktopError(text("Switch failed. The previous account directory was restored", "切换失败，已恢复原来的账号目录"));
  }
}

/** 只删除目录项本身。符号链接不跟随，共享目录里的文件会留下。 */
export async function removeDirectoryKeepingLinkTargets(
  dir: string,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      await unlink(full);
      continue;
    }
    if (entry.isDirectory()) {
      await removeDirectoryKeepingLinkTargets(full);
      continue;
    }
    await unlink(full);
  }
  await rmdir(dir);
}
