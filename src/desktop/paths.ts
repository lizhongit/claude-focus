import { homedir } from "node:os";
import path from "node:path";

/**
 * 这些目录在账号之间共用。
 * 会话索引放在同一棵树里，Desktop 只显示当前登录账号的那一层。
 * 缓存和运行时体积大，每个账号各存一份会重复占空间。
 * 链接用绝对路径，挪动账号目录后仍然指向共享目录。
 */
export const SHARED_DIR_NAMES = [
  "claude-code",
  "claude-code-sessions",
  "Cache",
  "Code Cache",
  "GPUCache",
  "GraphiteDawnCache",
  "DawnWebGPUCache",
  "DawnGraphiteCache",
  "GPUPersistentCache",
  "Crashpad",
  "VideoDecodeStats",
] as const;

export type SharedDirName = (typeof SHARED_DIR_NAMES)[number];

export function defaultClaudeDataDir(): string {
  return path.join(homedir(), "Library/Application Support/Claude");
}

export function defaultFocusRoot(): string {
  return path.join(homedir(), "Library/Application Support/cfocus");
}

export interface FocusPaths {
  claudeDataDir: string;
  focusRoot: string;
  backupDir: string;
  sharedDir: string;
  profilesDir: string;
  statePath: string;
}

export function focusPaths(options?: {
  claudeDataDir?: string;
  focusRoot?: string;
}): FocusPaths {
  const claudeDataDir = options?.claudeDataDir ?? defaultClaudeDataDir();
  const focusRoot = options?.focusRoot ?? defaultFocusRoot();
  return {
    claudeDataDir,
    focusRoot,
    backupDir: path.join(focusRoot, "backup", "initial"),
    sharedDir: path.join(focusRoot, "shared"),
    profilesDir: path.join(focusRoot, "profiles"),
    statePath: path.join(focusRoot, "state.json"),
  };
}

export function desktopConfigPath(dataDir: string): string {
  return path.join(dataDir, "config.json");
}

export function cookieDbPath(dataDir: string): string {
  return path.join(dataDir, "Cookies");
}
