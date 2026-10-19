import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { text } from "../i18n.ts";
import { DesktopError } from "./errors.ts";

const execFileAsync = promisify(execFile);

function assertMac(): void {
  if (process.platform !== "darwin") {
    throw new DesktopError(text("Switching Claude Desktop is only supported on macOS", "切换 Claude Desktop 只支持 macOS"));
  }
}

export async function quitClaudeDesktop(): Promise<void> {
  assertMac();
  try {
    await execFileAsync("osascript", ["-e", 'tell application "Claude" to quit']);
  } catch {
    throw new DesktopError(text("Could not quit Claude Desktop", "没能让 Claude Desktop 退出"));
  }
}

export async function launchClaudeDesktop(): Promise<void> {
  assertMac();
  try {
    await execFileAsync("open", ["-a", "Claude"]);
  } catch {
    throw new DesktopError(text("Could not reopen Claude Desktop", "没能重新打开 Claude Desktop"));
  }
}

export async function readSafeStoragePassword(): Promise<string> {
  assertMac();
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", "Claude Safe Storage", "-a", "Claude Key", "-w"],
      { encoding: "utf8" },
    );
    const password = stdout.trim();
    if (password === "") {
      throw new DesktopError(text("Claude Safe Storage is not in the keychain", "钥匙串里没有 Claude Safe Storage"));
    }
    return password;
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    throw new DesktopError(
      text(
        "Could not read Claude Safe Storage. macOS asks for keychain permission the first time.",
        "读取 Claude Safe Storage 失败。macOS 会在第一次询问钥匙串权限。",
      ),
    );
  }
}

export async function waitUntilStopped(options: {
  isRunning: () => boolean;
  timeoutMs: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const started = Date.now();
  while (options.isRunning()) {
    if (Date.now() - started >= options.timeoutMs) return false;
    await options.sleep(options.intervalMs);
  }
  return true;
}
