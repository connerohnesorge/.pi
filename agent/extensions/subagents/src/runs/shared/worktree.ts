import * as path from "node:path";
import { nodeWorktreeEffects, type WorktreeEffects } from "./worktree-effects.ts";
import {
	buildWorktreeBranch,
	buildWorktreePath,
	emptyDiff,
	findWorktreeTaskCwdConflictWithNormalizer,
	normalizeRepoPrefix,
	normalizeSyntheticPaths,
	parseHookTimeout,
	parseNumstat,
	parseWorktreeSetupHookOutput,
	resolveAgentCwd,
	resolveSyntheticPathForRemoval,
	resolveWorktreeSetupHookPath,
	safePatchAgentName,
	type CreateWorktreesOptions,
	type GitResult,
	type RepoState,
	type ResolvedWorktreeSetupHook,
	type WorktreeDiff,
	type WorktreeInfo,
	type WorktreeSetupHookInput,
	type WorktreeTaskCwdConflict,
} from "./worktree-policy.ts";

export type {
	CreateWorktreesOptions,
	WorktreeDiff,
	WorktreeInfo,
	WorktreeSetupHookConfig,
	WorktreeTaskCwdConflict,
} from "./worktree-policy.ts";
export { formatWorktreeDiffSummary, formatWorktreeTaskCwdConflict } from "./worktree-policy.ts";

export interface WorktreeSetup {
	cwd: string;
	worktrees: WorktreeInfo[];
	baseCommit: string;
}

function runGitChecked(effects: WorktreeEffects, cwd: string, args: string[]): string {
	const result = effects.runGit(cwd, args);
	if (result.status !== 0) {
		const command = `git -C ${cwd} ${args.join(" ")}`;
		const message = result.stderr.trim() || result.stdout.trim() || `${command} failed`;
		throw new Error(message);
	}
	return result.stdout;
}

function resolveRepoState(cwd: string, effects: WorktreeEffects = nodeWorktreeEffects): RepoState {
	const cwdRelative = resolveRepoCwdRelative(cwd, effects);
	const toplevel = runGitChecked(effects, cwd, ["rev-parse", "--show-toplevel"]).trim();

	const status = runGitChecked(effects, toplevel, ["status", "--porcelain"]);
	if (status.trim().length > 0) {
		throw new Error("worktree isolation requires a clean git working tree. Commit or stash changes first.");
	}

	const baseCommit = runGitChecked(effects, toplevel, ["rev-parse", "HEAD"]).trim();
	return { toplevel, cwdRelative, baseCommit };
}

function normalizeComparableCwd(cwd: string, effects: WorktreeEffects = nodeWorktreeEffects): string {
	const resolved = path.resolve(cwd);
	try {
		return effects.realpath(resolved);
	} catch {
		// Use the unresolved absolute path when realpath resolution is unavailable.
		return resolved;
	}
}

export function findWorktreeTaskCwdConflict(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
): WorktreeTaskCwdConflict | undefined {
	return findWorktreeTaskCwdConflictWithEffects(tasks, sharedCwd, nodeWorktreeEffects);
}

export function findWorktreeTaskCwdConflictWithEffects(
	tasks: ReadonlyArray<{ agent: string; cwd?: string }>,
	sharedCwd: string,
	effects: WorktreeEffects,
): WorktreeTaskCwdConflict | undefined {
	return findWorktreeTaskCwdConflictWithNormalizer(
		tasks,
		sharedCwd,
		(cwd) => normalizeComparableCwd(cwd, effects),
	);
}

function resolveRepoCwdRelative(cwd: string, effects: WorktreeEffects = nodeWorktreeEffects): string {
	const repoCheck: GitResult = effects.runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
		throw new Error("worktree isolation requires a git repository");
	}
	const rawPrefix = runGitChecked(effects, cwd, ["rev-parse", "--show-prefix"]).trim();
	return normalizeRepoPrefix(rawPrefix);
}

export function resolveExpectedWorktreeAgentCwd(cwd: string, runId: string, index: number): string {
	return resolveExpectedWorktreeAgentCwdWithEffects(cwd, runId, index, nodeWorktreeEffects);
}

export function resolveExpectedWorktreeAgentCwdWithEffects(
	cwd: string,
	runId: string,
	index: number,
	effects: WorktreeEffects,
): string {
	const cwdRelative = resolveRepoCwdRelative(cwd, effects);
	const worktreePath = buildWorktreePath(runId, index, effects.tmpdir());
	return resolveAgentCwd(worktreePath, cwdRelative);
}

function linkNodeModulesIfPresent(toplevel: string, worktreePath: string, effects: WorktreeEffects): boolean {
	const nodeModulesPath = path.join(toplevel, "node_modules");
	const nodeModulesLinkPath = path.join(worktreePath, "node_modules");
	if (!effects.pathExists(nodeModulesPath) || effects.pathExists(nodeModulesLinkPath)) return false;
	try {
		effects.symlink(nodeModulesPath, nodeModulesLinkPath);
		return true;
	} catch {
		// Symlink creation is optional (e.g., unsupported filesystems on CI runners).
		return false;
	}
}

function resolveWorktreeSetupHook(
	repoRoot: string,
	config: CreateWorktreesOptions["setupHook"],
	effects: WorktreeEffects,
): ResolvedWorktreeSetupHook | undefined {
	const hook = resolveWorktreeSetupHookPath(repoRoot, config, effects.homedir());
	if (!hook) return undefined;
	if (!effects.pathExists(hook.hookPath)) {
		throw new Error(`worktree setup hook not found: ${hook.hookPath}`);
	}
	if (effects.stat(hook.hookPath).isDirectory()) {
		throw new Error(`worktree setup hook must be a file, got directory: ${hook.hookPath}`);
	}
	return {
		hookPath: hook.hookPath,
		timeoutMs: parseHookTimeout(config?.timeoutMs),
	};
}

function hasTrackedEntries(worktreePath: string, relativePath: string, effects: WorktreeEffects): boolean {
	const result = effects.runGit(worktreePath, ["ls-files", "--", relativePath]);
	return result.status === 0 && result.stdout.trim().length > 0;
}

function runWorktreeSetupHook(
	hook: ResolvedWorktreeSetupHook,
	input: WorktreeSetupHookInput,
	effects: WorktreeEffects,
): string[] {
	const result = effects.runSetupHook(
		hook.hookPath,
		input.worktreePath,
		JSON.stringify(input),
		hook.timeoutMs,
	);

	if (result.error) {
		const code = result.error.code;
		if (code === "ETIMEDOUT") {
			throw new Error(`worktree setup hook timed out after ${hook.timeoutMs}ms`);
		}
		throw new Error(`worktree setup hook failed: ${result.error.message}`);
	}

	if (result.status !== 0) {
		const details = result.stderr.trim() || result.stdout.trim() || "no output";
		throw new Error(`worktree setup hook failed with exit code ${result.status}: ${details}`);
	}

	const output = parseWorktreeSetupHookOutput(result.stdout);
	const syntheticPaths = normalizeSyntheticPaths(input.worktreePath, output.syntheticPaths);
	for (const syntheticPath of syntheticPaths) {
		if (hasTrackedEntries(input.worktreePath, syntheticPath, effects)) {
			throw new Error(`worktree setup hook cannot mark tracked paths as synthetic: ${syntheticPath}`);
		}
	}
	return syntheticPaths;
}

function createSingleWorktree(
	toplevel: string,
	cwdRelative: string,
	runId: string,
	index: number,
	baseCommit: string,
	setupHook: ResolvedWorktreeSetupHook | undefined,
	agent: string | undefined,
	effects: WorktreeEffects,
): WorktreeInfo {
	const branch = buildWorktreeBranch(runId, index);
	const worktreePath = buildWorktreePath(runId, index, effects.tmpdir());
	const add = effects.runGit(toplevel, ["worktree", "add", worktreePath, "-b", branch, "HEAD"]);
	if (add.status !== 0) {
		const message = add.stderr.trim() || add.stdout.trim() || `failed to create worktree ${worktreePath}`;
		throw new Error(message);
	}

	const agentCwd = resolveAgentCwd(worktreePath, cwdRelative);
	try {
		const nodeModulesLinked = linkNodeModulesIfPresent(toplevel, worktreePath, effects);
		const syntheticPaths = nodeModulesLinked ? ["node_modules"] : [];

		if (setupHook) {
			const hookSyntheticPaths = runWorktreeSetupHook(setupHook, {
				version: 1,
				repoRoot: toplevel,
				worktreePath,
				agentCwd,
				branch,
				index,
				runId,
				baseCommit,
				agent,
			}, effects);
			syntheticPaths.push(...hookSyntheticPaths);
		}

		return {
			path: worktreePath,
			agentCwd,
			branch,
			index,
			nodeModulesLinked,
			syntheticPaths,
		};
	} catch (error) {
		try { runGitChecked(effects, toplevel, ["worktree", "remove", "--force", worktreePath]); } catch {
			// Best-effort rollback; preserve the original setup failure.
		}
		try { runGitChecked(effects, toplevel, ["branch", "-D", branch]); } catch {
			// Best-effort rollback; preserve the original setup failure.
		}
		throw error;
	}
}

function removeSyntheticPath(worktree: WorktreeInfo, syntheticPath: string, effects: WorktreeEffects): void {
	const resolved = resolveSyntheticPathForRemoval(worktree.path, syntheticPath);
	if (!resolved) return;

	let stat: ReturnType<WorktreeEffects["lstat"]>;
	try {
		stat = effects.lstat(resolved);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
		if (code === "ENOENT") return;
		throw error;
	}

	if (stat.isSymbolicLink()) {
		effects.unlink(resolved);
		return;
	}
	if (stat.isDirectory()) {
		effects.rm(resolved, { recursive: true, force: true });
		return;
	}
	effects.rm(resolved, { force: true });
}

function removeSyntheticPathsBeforeDiff(worktree: WorktreeInfo, effects: WorktreeEffects): void {
	if (worktree.syntheticPaths.length === 0) return;
	const seen = new Set<string>();
	for (const syntheticPath of worktree.syntheticPaths) {
		if (seen.has(syntheticPath)) continue;
		seen.add(syntheticPath);
		removeSyntheticPath(worktree, syntheticPath, effects);
	}
}

function captureWorktreeDiff(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	agent: string,
	patchPath: string,
	effects: WorktreeEffects,
): WorktreeDiff {
	removeSyntheticPathsBeforeDiff(worktree, effects);
	runGitChecked(effects, worktree.path, ["add", "-A"]);
	const diffStat = runGitChecked(effects, worktree.path, ["diff", "--cached", "--stat", setup.baseCommit]).trim();
	const patch = runGitChecked(effects, worktree.path, ["diff", "--cached", setup.baseCommit]);
	const numstat = runGitChecked(effects, worktree.path, ["diff", "--cached", "--numstat", setup.baseCommit]);
	effects.writeFile(patchPath, patch, "utf-8");

	if (!patch.trim()) {
		return emptyDiff(worktree.index, agent, worktree.branch, patchPath);
	}

	const parsed = parseNumstat(numstat);
	return {
		index: worktree.index,
		agent,
		branch: worktree.branch,
		diffStat,
		filesChanged: parsed.filesChanged,
		insertions: parsed.insertions,
		deletions: parsed.deletions,
		patchPath,
	};
}

function writeEmptyPatch(patchPath: string, effects: WorktreeEffects): void {
	try {
		effects.writeFile(patchPath, "", "utf-8");
	} catch {
		// Diff artifact writing is best-effort in error paths.
	}
}

function cleanupSingleWorktree(repoCwd: string, worktree: WorktreeInfo, effects: WorktreeEffects): void {
	try { runGitChecked(effects, repoCwd, ["worktree", "remove", "--force", worktree.path]); } catch {
		// Cleanup is best-effort to avoid masking caller errors.
	}
	try { runGitChecked(effects, repoCwd, ["branch", "-D", worktree.branch]); } catch {
		// Cleanup is best-effort to avoid masking caller errors.
	}
}

export function createWorktrees(cwd: string, runId: string, count: number, options?: CreateWorktreesOptions): WorktreeSetup {
	return createWorktreesWithEffects(cwd, runId, count, options, nodeWorktreeEffects);
}

export function createWorktreesWithEffects(
	cwd: string,
	runId: string,
	count: number,
	options: CreateWorktreesOptions | undefined,
	effects: WorktreeEffects,
): WorktreeSetup {
	const repo = resolveRepoState(cwd, effects);
	const setupHook = resolveWorktreeSetupHook(repo.toplevel, options?.setupHook, effects);
	const worktrees: WorktreeInfo[] = [];

	try {
		for (let index = 0; index < count; index++) {
			worktrees.push(createSingleWorktree(
				repo.toplevel,
				repo.cwdRelative,
				runId,
				index,
				repo.baseCommit,
				setupHook,
				options?.agents?.[index],
				effects,
			));
		}
	} catch (error) {
		cleanupWorktreesWithEffects({
			cwd: repo.toplevel,
			worktrees,
			baseCommit: repo.baseCommit,
		}, effects);
		throw error;
	}

	return {
		cwd: repo.toplevel,
		worktrees,
		baseCommit: repo.baseCommit,
	};
}

export function diffWorktrees(setup: WorktreeSetup, agents: string[], diffsDir: string): WorktreeDiff[] {
	return diffWorktreesWithEffects(setup, agents, diffsDir, nodeWorktreeEffects);
}

export function diffWorktreesWithEffects(
	setup: WorktreeSetup,
	agents: string[],
	diffsDir: string,
	effects: WorktreeEffects,
): WorktreeDiff[] {
	try {
		effects.mkdir(diffsDir, { recursive: true });
	} catch {
		// Returning no diffs is safer than failing the whole command on artifact-dir issues.
		return [];
	}

	const diffs: WorktreeDiff[] = [];
	for (let index = 0; index < setup.worktrees.length; index++) {
		const worktree = setup.worktrees[index]!;
		const agent = agents[index] ?? `task-${index + 1}`;
		const patchPath = path.join(diffsDir, `task-${index}-${safePatchAgentName(agent)}.patch`);
		try {
			diffs.push(captureWorktreeDiff(setup, worktree, agent, patchPath, effects));
		} catch {
			// Preserve execution flow; failed diff capture maps to an empty per-task patch.
			writeEmptyPatch(patchPath, effects);
			diffs.push(emptyDiff(index, agent, worktree.branch, patchPath));
		}
	}

	return diffs;
}

export function cleanupWorktrees(setup: WorktreeSetup): void {
	cleanupWorktreesWithEffects(setup, nodeWorktreeEffects);
}

export function cleanupWorktreesWithEffects(setup: WorktreeSetup, effects: WorktreeEffects): void {
	for (let index = setup.worktrees.length - 1; index >= 0; index--) {
		cleanupSingleWorktree(setup.cwd, setup.worktrees[index]!, effects);
	}
	try { runGitChecked(effects, setup.cwd, ["worktree", "prune"]); } catch {
		// Pruning is best-effort cleanup.
	}
}
