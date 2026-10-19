import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import type { SessionMeta } from "./sessions.ts";

export interface CopyPlan {
  sessionId: string;
  title: string;
  cliSessionId: string | null;
  sourcePath: string;
  destPath: string;
  action: "copy" | "skip-exists" | "overwrite";
}

export function planCopies(options: {
  sessions: SessionMeta[];
  destDir: string;
  overwrite: boolean;
  destExists: (destPath: string) => boolean;
}): CopyPlan[] {
  return options.sessions.map((session) => {
    const destPath = path.join(options.destDir, session.fileName);
    const exists = options.destExists(destPath);
    let action: CopyPlan["action"] = "copy";
    if (exists && options.overwrite) action = "overwrite";
    else if (exists) action = "skip-exists";
    return {
      sessionId: session.sessionId,
      title: session.title,
      cliSessionId: session.cliSessionId,
      sourcePath: session.filePath,
      destPath,
      action,
    };
  });
}

export async function applyCopies(
  plans: CopyPlan[],
  dryRun: boolean,
): Promise<{ copied: number; skipped: number; overwritten: number }> {
  let copied = 0;
  let skipped = 0;
  let overwritten = 0;
  for (const plan of plans) {
    if (plan.action === "skip-exists") {
      skipped += 1;
      continue;
    }
    if (dryRun) {
      if (plan.action === "overwrite") overwritten += 1;
      else copied += 1;
      continue;
    }
    await mkdir(path.dirname(plan.destPath), { recursive: true });
    if (plan.action === "overwrite") {
      await copyFile(plan.sourcePath, plan.destPath);
      overwritten += 1;
      continue;
    }
    try {
      await copyFile(plan.sourcePath, plan.destPath, constants.COPYFILE_EXCL);
      copied += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        skipped += 1;
        continue;
      }
      throw error;
    }
  }
  return { copied, skipped, overwritten };
}
