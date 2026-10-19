import { execFileSync } from "node:child_process";

/** Claude Desktop 的进程名。命令行里的 claude 不写侧边栏索引，不拦截。 */
export function claudeDesktopRunning(): boolean {
  try {
    execFileSync("pgrep", ["-x", "Claude"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
