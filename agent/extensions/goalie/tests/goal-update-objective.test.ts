import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCompletionReport, validateGoalUpdate } from "../extensions/goal-policy.ts";
import { createGoal } from "../extensions/goal-record.ts";
import {
	archiveGoalFile,
	readActiveGoalPool,
	writeActiveGoalFile,
} from "../extensions/storage/goal-files.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

interface TestContext {
	cwd: string;
}

function tempCtx(): TestContext {
	return { cwd: mkdtempSync(path.join(tmpdir(), "goal-update-objective-test-")) };
}

function cleanup(ctx: TestContext): void {
	try {
		rmSync(ctx.cwd, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		...createGoal({
			objective: "Original objective: build feature X",
			autoContinue: true,
			sisyphus: false,
		}, Date.UTC(2026, 5, 2, 10, 0, 0)),
		...overrides,
	};
}

// ─── validateGoalUpdate (handler gate) ───────────────────────────────────────

test("validateGoalUpdate rejects null goal (no goal exists)", () => {
	const result = validateGoalUpdate({ goal: null });
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.match(result.message, /cannot update objective/);
		assert.match(result.message, /No goal is set/);
	}
});

test("validateGoalUpdate rejects complete goal", () => {
	const goal = makeGoal({ status: "complete" } as GoalRecord);
	const result = validateGoalUpdate({ goal });
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.match(result.message, /cannot update objective/);
		assert.match(result.message, /already complete/);
	}
});

test("validateGoalUpdate accepts active goal", () => {
	const result = validateGoalUpdate({ goal: makeGoal() });
	assert.equal(result.ok, true);
});

test("validateGoalUpdate accepts paused goal", () => {
	const result = validateGoalUpdate({ goal: makeGoal({ status: "paused" }) });
	assert.equal(result.ok, true);
});

// ─── update_goal({updatedObjective}) quick-sync path ─────────────────────────

test("update_goal with updatedObjective updates objective in memory and on disk", () => {
	const ctx = tempCtx();
	try {
		const originalObj = "Original objective: build feature X";
		const newObj = "Updated objective: build feature Y after requirements change";

		const goal = makeGoal({ objective: originalObj });
		const active = writeActiveGoalFile(ctx, goal);
		assert.equal(active.status, "active");
		assert.equal(active.objective, originalObj);

		const activeFilePath = path.join(ctx.cwd, active.activePath ?? "missing");
		assert.ok(readFileSync(activeFilePath, "utf8").includes(originalObj));

		const pool1 = readActiveGoalPool(ctx);
		assert.ok(pool1.has(goal.id));

		const updated = writeActiveGoalFile(ctx, { ...active, objective: newObj });
		assert.equal(updated.status, "active");
		assert.equal(updated.objective, newObj);
		assert.match(updated.activePath ?? "", /^\.pi\/goals\/active_goal_/);
		assert.equal(updated.archivedPath, undefined);

		const disk2 = readFileSync(activeFilePath, "utf8");
		assert.ok(disk2.includes(newObj));
		assert.ok(!disk2.includes(originalObj));
		assert.ok(disk2.includes('"status": "active"'));

		assert.ok(readActiveGoalPool(ctx).has(goal.id));
		assert.equal(updated.activePath, active.activePath);
	} finally {
		cleanup(ctx);
	}
});

// ─── combined updatedObjective + status=complete path ────────────────────────

test("combined updatedObjective + status=complete applies update before completion", () => {
	const ctx = tempCtx();
	try {
		const originalObj = "Original objective for combined test";
		const newObj = "Updated before complete: final requirement";

		const goal = makeGoal({ objective: originalObj });
		const active = writeActiveGoalFile(ctx, goal);
		assert.equal(active.objective, originalObj);

		const combined = writeActiveGoalFile(ctx, {
			...active,
			objective: newObj,
			status: "complete" as const,
			stopReason: "agent" as const,
			updatedAt: new Date().toISOString(),
		});
		assert.equal(combined.objective, newObj);
		assert.equal(combined.status, "complete");
		assert.match(combined.activePath ?? "", /^\.pi\/goals\/active_goal_/);
		assert.equal(combined.archivedPath, undefined);

		const diskContent = readFileSync(path.join(ctx.cwd, combined.activePath ?? "missing"), "utf8");
		assert.ok(diskContent.includes(newObj));
		assert.ok(diskContent.includes('"status": "complete"'));

		const archived = archiveGoalFile(ctx, combined);
		assert.equal(archived.activePath, undefined);
		assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/);
		const archivedContent = readFileSync(path.join(ctx.cwd, archived.archivedPath ?? "missing"), "utf8");
		assert.ok(archivedContent.includes(newObj));
		assert.ok(archivedContent.includes('"status": "complete"'));
	} finally {
		cleanup(ctx);
	}
});

// ─── buildCompletionReport ──────────────────────────────────────────────────

test("buildCompletionReport handles updated objective display", () => {
	const report = buildCompletionReport({
		detailedSummary: "Goal: Build feature X\nUpdated objective: Build feature Y\nStatus: active",
		completionSummary: "Feature Y built successfully.",
		auditorReport: "Inspected and verified.\n\n<approved/>",
	});
	assert.ok(report.includes("Goal complete."));
	assert.ok(report.includes("<approved/>"));
});

// ─── apply_goal_tweak handler simulation ─────────────────────────────────────
// The apply_goal_tweak handler writes the new objective via writeActiveGoalFile,
// appends a state entry, clears tweakDraftingFor, sets turnStoppedFor, and
// returns terminate:true. We simulate the storage-level write and verify
// the goal is updated on disk.

test("apply_goal_tweak path: writeActiveGoalFile with new objective (simulated handler execution)", () => {
	const ctx = tempCtx();
	try {
		const originalObj = "Original objective";
		const newObj = "Tweaked objective after /goal-tweak interview";

		// Write the original active goal
		const goal = makeGoal({ objective: originalObj });
		const active = writeActiveGoalFile(ctx, goal);
		assert.equal(active.objective, originalObj);

		// Simulate apply_goal_tweak: write with new objective (same pattern
		// the handler uses: spread state goal, set new objective + updatedAt)
		const tweaked = writeActiveGoalFile(ctx, {
			...active,
			objective: newObj,
			updatedAt: new Date().toISOString(),
		});
		assert.equal(tweaked.objective, newObj, "objective must be updated");
		assert.equal(tweaked.status, "active", "status must remain active after tweak");
		assert.equal(tweaked.activePath, active.activePath,
			"active file path should not change on tweak");

		// Verify disk has the updated objective
		const diskContent = readFileSync(path.join(ctx.cwd, tweaked.activePath ?? "missing"), "utf8");
		assert.ok(diskContent.includes(newObj), "disk must have the tweaked objective");
		assert.ok(diskContent.includes('"status": "active"'), "disk must show active status");

		// Verify still in the active pool
		const pool = readActiveGoalPool(ctx);
		assert.ok(pool.has(goal.id), "tweaked goal must still be in active pool");
	} finally {
		cleanup(ctx);
	}
});

// ─── prompt evolution instruction ────────────────────────────────────────────

test("goal evolution instruction is present in continuationPrompt and goalPrompt", async () => {
	const { goalPrompt, continuationPrompt } = await import("../extensions/prompts/goal-prompts.ts");
	const goal = makeGoal();

	const contText = continuationPrompt(goal);
	assert.ok(contText.includes("Goal evolution:"), "continuationPrompt must include Goal evolution instruction");
	assert.ok(contText.includes("updatedObjective"), "continuationPrompt must reference updatedObjective");
	assert.ok(contText.includes("stale"), "continuationPrompt must mention stale goals");
	assert.ok(contText.includes("/goalie-edit"), "continuationPrompt must mention /goalie-edit as an alternative");

	const goalText = goalPrompt(goal);
	assert.ok(goalText.includes("Goal evolution:"), "goalPrompt must include Goal evolution instruction");
	assert.ok(goalText.includes("updatedObjective"), "goalPrompt must reference updatedObjective");
});
