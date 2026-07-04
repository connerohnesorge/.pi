import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempGitRepo {
  repo: string;
  git: (...args: string[]) => Buffer;
}

export async function withTempGitRepo<T>(prefix: string, fn: (repo: TempGitRepo) => Promise<T>): Promise<T> {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    return await fn({ repo, git });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}
