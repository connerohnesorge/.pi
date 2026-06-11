import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildCompletionReport } from "../extensions/goal-policy.ts";
import {
	readActiveGoalFiles,
	readActiveGoalPool,
	writeActiveGoalFile,
} from "../extensions/storage/goal-files.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";
import { assertExcludesAll, assertIncludesAll } from "./helpers/assertions.ts";
import {
	archiveCompletedGoal,
	cleanupGoalContext,
	completeGoalOnDisk,
	createTempGoalContext,
	createTestGoal,
	readActiveGoalText,
} from "./helpers/goal-test-helpers.ts";

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return createTestGoal({
		objective: "Deferred archival test goal",
		at: Date.UTC(2026, 5, 2, 10, 0, 0),
		overrides,
	});
}

function fileExists(filePath: string): boolean {
	try {
		readFileSync(filePath);
		return true;
	} catch {
		return false;
	}
}

/**
 * Simulates the full lifecycle that update_goal + turn_end perform:
 * 1. Write goal as active (normal)
 * 2. Mark complete with deferred write (update_goal behavior)
 * 3. Verify NOT archived yet
 * 4. Archive (turn_end behavior)
 * 5. Verify IS archived
 */
test("deferred archival lifecycle via writeActiveGoalFile then archiveGoalFile", () => {
	const ctx = createTempGoalContext("goal-deferred-archival-test-");
	try {
		// Step 1: Create and write an active goal
		const goal = makeGoal();
		const active = writeActiveGoalFile(ctx, goal);
		assert.match(active.activePath ?? "", /^\.pi\/goals\/active_goal_/);
		assert.equal(active.archivedPath, undefined, "fresh goal should not have archivedPath");
		assert.ok(readActiveGoalPool(ctx).has(goal.id), "goal should be in active pool before completion");

		// Step 2: Simulate update_goal — mark complete via writeActiveGoalFile (deferred archival)
		const completed = completeGoalOnDisk(ctx, active, { stopReason: active.stopReason });
		assert.match(completed.activePath ?? "", /^\.pi\/goals\/active_goal_/, "complete goal should still have activePath (deferred)");
		assert.equal(completed.archivedPath, undefined, "complete goal should NOT have archivedPath yet (deferred)");
		assert.ok(readActiveGoalText(ctx, completed).includes('"status": "complete"'), "active file on disk must have status: complete");
		assert.equal(readActiveGoalPool(ctx).has(goal.id), false, "complete goal should NOT be in active pool (readActiveGoalFiles filters complete)");

		// Step 2c: Verify the goal is NOT in the archive directory
		const archiveDir = path.join(ctx.cwd, ".pi", "goals", "archived");
		assert.equal(fileExists(path.join(archiveDir, path.basename(completed.archivedPath ?? "null"))), false,
			"goal should NOT be in archive dir yet");

		// Step 3: Simulate turn_end — archive via archiveGoalFile
		const archived = archiveCompletedGoal(ctx, completed);
		assert.equal(archived.activePath, undefined, "archived goal should not have activePath");
		assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/, "archived goal must have archivedPath in archive dir");
		assert.equal(fileExists(path.join(ctx.cwd, completed.activePath ?? "missing")), false,
			"active file should be removed after archival");
		assert.ok(fileExists(path.join(ctx.cwd, archived.archivedPath ?? "missing")),
			"archived file should exist on disk");

		// Step 3d: Verify the goal is NOT in readActiveGoalFiles at all (filtered out regardless)
		const activeFiles = readActiveGoalFiles(ctx);
		const ids = activeFiles.map((g) => g.id);
		assert.equal(ids.includes(goal.id), false, "goal should not appear in active files after archival");
	} finally {
		cleanupGoalContext(ctx);
	}
});

/**
 * Verify the approval-path tool output includes the full auditor report.
 */
test("approval path: buildCompletionReport includes auditor report", () => {
	const report = buildCompletionReport({
		detailedSummary: "Goal: Audit approval test\nStatus: active",
		completionSummary: "All requirements satisfied.",
		auditorReport: "Auditor: I have verified all requirements.\n\n<approved/>",
	});
	assertIncludesAll(report, [
		"Goal audit approved.",
		"<approved/>",
		"Auditor: I have verified all requirements.",
		"Goal complete.",
	]);
});

/**
 * Verify the disabled-bypass tool output includes the skip reason.
 */
test("disabled-bypass path: buildCompletionReport includes auditSkippedReason", () => {
	const report = buildCompletionReport({
		detailedSummary: "Goal: Disabled bypass test\nStatus: active",
		completionSummary: "Marked complete via bypass.",
		auditSkippedReason: "auditor disabled in settings",
	});
	assertIncludesAll(report, ["Goal audit skipped.", "auditor disabled in settings", "Goal complete."]);
	assertExcludesAll(report, ["<approved/>", "Auditor approval:"]);
});

/**
 * Verify the Esc-skip tool output includes the Esc-specific skip reason.
 */
test("Esc-skip path: buildCompletionReport includes Esc-abort reason", () => {
	const report = buildCompletionReport({
		detailedSummary: "Goal: Esc abort test\nStatus: active",
		completionSummary: "Bypassed during audit.",
		auditSkippedReason: "auditor bypassed (user pressed Escape during audit)",
	});
	assertIncludesAll(report, ["Goal audit skipped.", "auditor bypassed (user pressed Escape during audit)", "Goal complete."]);
});

/**
 * Verify all three paths produce distinct tool output text using the same
 * underlying buildCompletionReport function.
 */
test("all three paths produce distinct tool output text", () => {
	const commonDetailed = "Goal: Distinct output test\nStatus: active";
	const approval = buildCompletionReport({
		detailedSummary: commonDetailed,
		completionSummary: "Approved case.",
		auditorReport: "Inspected and verified.\n\n<approved/>",
	});
	const disabled = buildCompletionReport({
		detailedSummary: commonDetailed,
		completionSummary: "Disabled bypass case.",
		auditSkippedReason: "auditor disabled in settings",
	});
	const esc = buildCompletionReport({
		detailedSummary: commonDetailed,
		completionSummary: "Esc abort case.",
		auditSkippedReason: "auditor bypassed (user pressed Escape during audit)",
	});

	assertIncludesAll(approval, ["Goal audit approved."]);
	assertIncludesAll(disabled, ["Goal audit skipped.", "auditor disabled in settings"]);
	assertIncludesAll(esc, ["Goal audit skipped.", "auditor bypassed (user pressed Escape during audit)"]);
	assertExcludesAll(approval, ["Goal audit skipped."]);
	assertExcludesAll(disabled, ["<approved/>"]);
	assertExcludesAll(esc, ["<approved/>"]);
});

/**
 * Verify that readActiveGoalFiles filters out complete goals (even if archivedPath
 * is not set — deferred state). This ensures the 'update_goal returns but goal
 * not yet archived' state is handled correctly by the pool.
 */
test("readActiveGoalFiles filters complete goals regardless of archivedPath", () => {
	const ctx = createTempGoalContext("goal-deferred-archival-test-");
	try {
		// Write an active goal
		const goal = makeGoal({ id: "complete-filter-test" });
		const active = writeActiveGoalFile(ctx, goal);
		assert.ok(readActiveGoalPool(ctx).has("complete-filter-test"), "active goal should be in pool");

		// Mark complete without archiving (simulating deferred state)
		const completeButNotArchived = completeGoalOnDisk(ctx, active, { stopReason: active.stopReason });
		assert.match(completeButNotArchived.activePath ?? "", /^\.pi\/goals\/active_goal_/);
		assert.equal(readActiveGoalPool(ctx).has("complete-filter-test"), false,
			"complete goal should be filtered from pool even if not archived");

		// Now archive it to clean up
		archiveCompletedGoal(ctx, completeButNotArchived);
		assert.equal(readActiveGoalPool(ctx).has("complete-filter-test"), false,
			"archived goal should not be in pool");
	} finally {
		cleanupGoalContext(ctx);
	}
});

/**
 * Verify that a goal with status complete but no archivedPath is correctly
 * detected by the archival logic that mirrors turn_end.
 */
test("detect complete-but-not-archived goal for turn_end archival", () => {
	const ctx = createTempGoalContext("goal-deferred-archival-test-");
	try {
		const active = writeActiveGoalFile(ctx, makeGoal({ id: "pending-archival-detect" }));
		const deferred = completeGoalOnDisk(ctx, active, { stopReason: active.stopReason });

		// The condition the turn_end handler checks:
		//   state.goal?.status === "complete" && !state.goal?.archivedPath
		assert.equal(deferred.status, "complete");
		assert.equal(deferred.archivedPath, undefined);
		assert.match(deferred.activePath ?? "", /^\.pi\/goals\/active_goal_/);

		// Simulate turn_end — archive the goal
		const archResult = archiveCompletedGoal(ctx, deferred);
		assert.equal(archResult.activePath, undefined, "after archival, activePath must be removed");
		assert.match(archResult.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/, "after archival, archivedPath must be set");
	} finally {
		cleanupGoalContext(ctx);
	}
});
