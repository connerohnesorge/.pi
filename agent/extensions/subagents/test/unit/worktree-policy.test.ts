import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import type { WorktreeEffects } from "../../src/runs/shared/worktree-effects.ts";
import {
	findWorktreeTaskCwdConflictWithEffects,
	resolveExpectedWorktreeAgentCwdWithEffects,
} from "../../src/runs/shared/worktree.ts";
import {
	buildWorktreeBranch,
	buildWorktreePath,
	findWorktreeTaskCwdConflictWithNormalizer,
	formatWorktreeDiffSummary,
	normalizeRepoPrefix,
	normalizeSyntheticPaths,
	parseHookTimeout,
	parseNumstat,
	parseWorktreeSetupHookOutput,
	resolveAgentCwd,
	resolveSyntheticPathForRemoval,
	resolveWorktreeSetupHookPath,
	safePatchAgentName,
} from "../../src/runs/shared/worktree-policy.ts";

describe("worktree policy", () => {
	it("derives deterministic branch, path, cwd, and patch names", () => {
		assert.equal(buildWorktreeBranch("run-1", 2), "pi-parallel-run-1-2");
		assert.equal(buildWorktreePath("run-1", 2, "/tmp/policy"), path.join("/tmp/policy", "pi-worktree-run-1-2"));
		assert.equal(resolveAgentCwd("/tmp/worktree", "packages/app"), path.join("/tmp/worktree", "packages/app"));
		assert.equal(resolveAgentCwd("/tmp/worktree", ""), "/tmp/worktree");
		assert.equal(safePatchAgentName("worker/a b:c"), "worker_a_b_c");
		assert.equal(normalizeRepoPrefix("packages/app/"), path.join("packages", "app"));
	});

	it("finds cwd conflicts through an injected normalizer", () => {
		const normalized = new Map([
			["/repo", "/real/repo"],
			["/repo/.", "/real/repo"],
			["/repo/packages/app", "/real/repo/packages/app"],
		]);
		const normalize = (cwd: string) => normalized.get(cwd) ?? cwd;

		assert.equal(
			findWorktreeTaskCwdConflictWithNormalizer([{ agent: "a", cwd: "." }], "/repo", normalize),
			undefined,
		);
		assert.deepEqual(
			findWorktreeTaskCwdConflictWithNormalizer([{ agent: "b", cwd: "packages/app" }], "/repo", normalize),
			{ index: 0, agent: "b", cwd: "packages/app" },
		);
	});

	it("validates hook paths and timeouts without filesystem checks", () => {
		assert.equal(parseHookTimeout(undefined), 30000);
		assert.equal(parseHookTimeout(50), 50);
		assert.throws(() => parseHookTimeout(0), /integer greater than 0/);
		assert.deepEqual(
			resolveWorktreeSetupHookPath("/repo", { hookPath: "scripts/setup.mjs", timeoutMs: 10 }, "/home/me"),
			{ hookPath: path.join("/repo", "scripts", "setup.mjs") },
		);
		assert.deepEqual(
			resolveWorktreeSetupHookPath("/repo", { hookPath: "~/setup.mjs" }, "/home/me"),
			{ hookPath: path.join("/home/me", "setup.mjs") },
		);
		assert.throws(() => resolveWorktreeSetupHookPath("/repo", { hookPath: "node" }), /absolute path or a repo-relative path/);
	});

	it("parses and validates hook synthetic paths without git or filesystem effects", () => {
		const output = parseWorktreeSetupHookOutput(JSON.stringify({ syntheticPaths: [".venv", "nested/../cache", ".venv"] }));
		assert.deepEqual(normalizeSyntheticPaths("/tmp/worktree", output.syntheticPaths), [".venv", "cache"]);

		assert.throws(() => parseWorktreeSetupHookOutput(""), /empty stdout/);
		assert.throws(() => parseWorktreeSetupHookOutput("[]"), /stdout must be a JSON object/);
		assert.throws(() => normalizeSyntheticPaths("/tmp/worktree", "cache"), /must be an array/);
		assert.throws(() => normalizeSyntheticPaths("/tmp/worktree", ["/tmp/worktree/cache"]), /must be relative/);
		assert.throws(() => normalizeSyntheticPaths("/tmp/worktree", ["../outside"]), /escapes the worktree root/);
		assert.throws(() => normalizeSyntheticPaths("/tmp/worktree", ["."]), /cannot target the worktree root/);
	});

	it("guards synthetic path removal against escaping the worktree", () => {
		assert.equal(resolveSyntheticPathForRemoval("/tmp/worktree", "cache"), path.join("/tmp/worktree", "cache"));
		assert.equal(resolveSyntheticPathForRemoval("/tmp/worktree", "../outside"), undefined);
		assert.equal(resolveSyntheticPathForRemoval("/tmp/worktree", "."), undefined);
	});

	it("parses numstat and formats summaries without invoking git", () => {
		assert.deepEqual(parseNumstat("3\t1\tsrc/a.ts\n-\t-\tassets/logo.png\n"), {
			filesChanged: 2,
			insertions: 3,
			deletions: 1,
		});
		assert.equal(formatWorktreeDiffSummary([{ index: 0, agent: "worker", branch: "b", diffStat: " src/a.ts | 4 ++--", filesChanged: 1, insertions: 2, deletions: 2, patchPath: "/tmp/diffs/task-0.patch" }]), "=== Worktree Changes ===\n\n--- Task 1 (worker): 1 files changed, +2 -2 ---\n src/a.ts | 4 ++--\n\nFull patches: /tmp/diffs");
		assert.equal(formatWorktreeDiffSummary([{ index: 0, agent: "worker", branch: "b", diffStat: "", filesChanged: 0, insertions: 0, deletions: 0, patchPath: "/tmp/diffs/task-0.patch" }]), "");
	});

	it("routes preview and conflict helpers through injected effects", () => {
		const fakeEffects: WorktreeEffects = {
			tmpdir: () => "/tmp/fake",
			homedir: () => "/home/fake",
			runGit(_cwd, args) {
				if (args.join(" ") === "rev-parse --is-inside-work-tree") return { stdout: "true\n", stderr: "", status: 0 };
				if (args.join(" ") === "rev-parse --show-prefix") return { stdout: "packages/app/\n", stderr: "", status: 0 };
				return { stdout: "", stderr: "unexpected git", status: 1 };
			},
			pathExists: () => false,
			stat: () => { throw new Error("unused"); },
			lstat: () => { throw new Error("unused"); },
			realpath: (filePath) => filePath.replace("/repo", "/real/repo"),
			symlink: () => {},
			unlink: () => {},
			rm: () => {},
			mkdir: () => {},
			writeFile: () => {},
			runSetupHook: () => ({ stdout: "", stderr: "", status: 0 }),
		};

		assert.equal(
			resolveExpectedWorktreeAgentCwdWithEffects("/repo/packages/app", "abc", 3, fakeEffects),
			path.join("/tmp/fake", "pi-worktree-abc-3", "packages", "app"),
		);
		assert.deepEqual(
			findWorktreeTaskCwdConflictWithEffects([{ agent: "worker", cwd: "other" }], "/repo", fakeEffects),
			{ index: 0, agent: "worker", cwd: "other" },
		);
	});
});
