import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import type { GitResult } from "./worktree-policy.ts";

export interface HookRunResult {
	stdout: string;
	stderr: string;
	status: number | null;
	error?: Error & { code?: unknown };
}

export interface WorktreeEffects {
	tmpdir(): string;
	homedir(): string;
	runGit(cwd: string, args: string[]): GitResult;
	pathExists(filePath: string): boolean;
	stat(filePath: string): fs.Stats;
	lstat(filePath: string): fs.Stats;
	realpath(filePath: string): string;
	symlink(target: string, filePath: string): void;
	unlink(filePath: string): void;
	rm(filePath: string, options: fs.RmOptions): void;
	mkdir(filePath: string, options: fs.MakeDirectoryOptions): void;
	writeFile(filePath: string, data: string, encoding: BufferEncoding): void;
	runSetupHook(hookPath: string, cwd: string, input: string, timeoutMs: number): HookRunResult;
}

export const nodeWorktreeEffects: WorktreeEffects = {
	tmpdir: () => os.tmpdir(),
	homedir: () => os.homedir(),
	runGit(cwd, args) {
		const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			status: result.status,
		};
	},
	pathExists: (filePath) => fs.existsSync(filePath),
	stat: (filePath) => fs.statSync(filePath),
	lstat: (filePath) => fs.lstatSync(filePath),
	realpath: (filePath) => fs.realpathSync(filePath),
	symlink: (target, filePath) => fs.symlinkSync(target, filePath),
	unlink: (filePath) => fs.unlinkSync(filePath),
	rm: (filePath, options) => fs.rmSync(filePath, options),
	mkdir: (filePath, options) => fs.mkdirSync(filePath, options),
	writeFile: (filePath, data, encoding) => fs.writeFileSync(filePath, data, encoding),
	runSetupHook(hookPath, cwd, input, timeoutMs) {
		const result = spawnSync(hookPath, [], {
			cwd,
			encoding: "utf-8",
			input,
			timeout: timeoutMs,
			shell: false,
		});
		const hookResult: HookRunResult = {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			status: result.status,
		};
		if (result.error) hookResult.error = result.error as HookRunResult["error"];
		return hookResult;
	},
};
