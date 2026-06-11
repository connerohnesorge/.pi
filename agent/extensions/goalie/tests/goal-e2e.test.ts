import assert from "node:assert/strict";
import test from "node:test";

import { buildCompletionReport } from "../extensions/goal-policy.ts";
import { readActiveGoalPool, writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";
import { assertExcludesAll, assertIncludesAll } from "./helpers/assertions.ts";
import {
	archiveCompletedGoal,
	assertAllowsGoalUpdate,
	assertRejectsCompleteGoalUpdate,
	assertRejectsMissingGoalUpdate,
	cleanupGoalContext,
	completeGoalOnDisk,
	createTempGoalContext,
	createTestGoal,
	readActiveGoalText,
	readArchivedGoalText,
} from "./helpers/goal-test-helpers.ts";

const TEST_PREFIX = "goal-e2e-test-";

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return createTestGoal({
		objective: "Initial objective for e2e test",
		at: Date.UTC(2026, 5, 26, 8, 0, 0),
		overrides,
	});
}

// ── 1. Sequential quick-syncs ────────────────────────────────────────────────
// Simulates: agent detects drift, calls update_goal({updatedObjective}),
// then detects more drift, calls update_goal({updatedObjective}) again.
// Only the latest objective should be on disk.

test("sequential quick-syncs: two updates, only latest objective on disk", () => {
	const ctx = createTempGoalContext(TEST_PREFIX);
	try {
		const obj1 = "First objective";
		const obj2 = "Second objective after more drift";
		const obj3 = "Third objective — final version";

		const goal = makeGoal({ objective: obj1 });
		const active = writeActiveGoalFile(ctx, goal);
		assert.equal(active.objective, obj1);

		// Update 1
		const after1 = writeActiveGoalFile(ctx, { ...active, objective: obj2 });
		assert.equal(after1.objective, obj2);
		assert.equal(after1.status, "active");

		// Update 2
		const after2 = writeActiveGoalFile(ctx, { ...after1, objective: obj3 });
		assert.equal(after2.objective, obj3);
		assert.equal(after2.status, "active");

		// Only obj3 on disk
		const disk = readActiveGoalText(ctx, after2);
		assertExcludesAll(disk, [obj1, obj2]);
		assert.ok(disk.includes(obj3), "obj3 should be on disk");

		// Pool membership unchanged, same active file path
		assert.ok(readActiveGoalPool(ctx).has(goal.id));
		assert.equal(after2.activePath, active.activePath);
	} finally {
		cleanupGoalContext(ctx);
	}
});

// ── 2. Quick-sync then later complete (separate calls) ────────────────────────
// Simulates: agent syncs objective mid-flight, continues work, then later
// marks complete. The archived file should have the updated objective.

test("quick-sync then later complete: archived file has updated objective", () => {
	const ctx = createTempGoalContext(TEST_PREFIX);
	try {
		const originalObj = "Original objective";
		const updatedObj = "Updated objective after requirements changed";
		const active = writeActiveGoalFile(ctx, makeGoal({ objective: originalObj }));

		// Step 1: Quick sync (simulating update_goal({updatedObjective}))
		const synced = writeActiveGoalFile(ctx, { ...active, objective: updatedObj });
		assert.equal(synced.objective, updatedObj);
		assert.equal(synced.status, "active");
		assert.equal(synced.archivedPath, undefined);

		// Step 2: Later, mark complete; Step 3: turn_end archives
		const archived = archiveCompletedGoal(ctx, completeGoalOnDisk(ctx, synced));
		assert.equal(archived.activePath, undefined);
		assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/);

		// Verify archived file has the updated objective
		const archivedContent = readArchivedGoalText(ctx, archived);
		assert.ok(archivedContent.includes(updatedObj),
			"archived file must have the updated objective (not the original)");
		assert.ok(!archivedContent.includes(originalObj),
			"archived file must NOT have the original objective");
		assert.ok(archivedContent.includes('"status": "complete"'),
			"archived file must have complete status");
	} finally {
		cleanupGoalContext(ctx);
	}
});

// ── 3. Sync + approval path ──────────────────────────────────────────────────
// Simulates: objective updated, then completion with audit approval.
// Verifies the buildCompletionReport includes the updated objective context.

test("sync + approval path: report includes new objective and approval", () => {
	const report = buildCompletionReport({
		detailedSummary: "Goal: Build feature X\nUpdated objective: Build feature Y\nStatus: active",
		completionSummary: "Feature Y implemented and tested.",
		auditorReport: "Inspected and verified.\n\n<approved/>",
	});
	assertIncludesAll(report, ["Goal audit approved.", "<approved/>", "Goal complete.", "Feature Y"]);
});

// ── 4. Sync + disabled bypass ────────────────────────────────────────────────
// Verifies the buildCompletionReport with updated objective + skip reason.

test("sync + disabled bypass: report includes new objective and skip reason", () => {
	const report = buildCompletionReport({
		detailedSummary: "Goal: Build feature X\nUpdated objective: Build feature Y\nStatus: active",
		completionSummary: "Feature Y implemented.",
		auditSkippedReason: "auditor disabled in settings",
	});
	assertIncludesAll(report, ["Goal audit skipped.", "auditor disabled in settings", "Goal complete.", "Feature Y"]);
	assertExcludesAll(report, ["<approved/>"]);
});

// ── 5. Sync + Esc bypass ─────────────────────────────────────────────────────
// Verifies the buildCompletionReport with updated objective + Esc reason.

test("sync + Esc bypass: report includes new objective and Esc reason", () => {
	const report = buildCompletionReport({
		detailedSummary: "Goal: Build feature X\nUpdated objective: Build feature Y\nStatus: active",
		completionSummary: "Feature Y implemented.",
		auditSkippedReason: "auditor bypassed (user pressed Escape during audit)",
	});
	assertIncludesAll(report, ["Goal audit skipped.", "auditor bypassed (user pressed Escape during audit)", "Goal complete.", "Feature Y"]);
	assertExcludesAll(report, ["<approved/>"]);
});

// ── 6. Multiple syncs → complete ─────────────────────────────────────────────
// Simulates: three sequential objective updates, then complete.
// Final archived file must have the third (latest) objective.

test("multiple syncs then complete: final objective in archived file", () => {
	const ctx = createTempGoalContext(TEST_PREFIX);
	try {
		const objs = ["First objective", "Second objective", "Third and final objective"];
		let current = writeActiveGoalFile(ctx, makeGoal({ objective: objs[0] }));

		// Three sequential quick-syncs
		for (const obj of objs) {
			current = writeActiveGoalFile(ctx, { ...current, objective: obj });
			assert.equal(current.objective, obj);
			assert.equal(current.status, "active");
		}

		// Mark complete and archive (turn_end)
		const archived = archiveCompletedGoal(ctx, completeGoalOnDisk(ctx, current));
		const archivedContent = readArchivedGoalText(ctx, archived);

		// Only the last objective
		assert.ok(archivedContent.includes(objs[2]), "archived must have the final objective");
		assert.ok(!archivedContent.includes(objs[0]), "archived must NOT have obj1");
		assert.ok(!archivedContent.includes(objs[1]), "archived must NOT have obj2");
	} finally {
		cleanupGoalContext(ctx);
	}
});

// ── 7. Sync while paused ─────────────────────────────────────────────────────
// Simulates: goal is paused, agent syncs objective via update_goal.
// Status stays paused, objective changes on disk.

test("sync while paused: status stays paused, objective changed on disk", () => {
	const ctx = createTempGoalContext(TEST_PREFIX);
	try {
		const originalObj = "Paused goal objective";
		const newObj = "Updated while paused";
		const paused = writeActiveGoalFile(ctx, makeGoal({ objective: originalObj, status: "paused" }));
		assert.equal(paused.status, "paused");
		assert.equal(paused.objective, originalObj);
		assertAllowsGoalUpdate(paused);

		// Update objective while paused
		const updated = writeActiveGoalFile(ctx, { ...paused, objective: newObj });
		assert.equal(updated.status, "paused", "status must stay paused");
		assert.equal(updated.objective, newObj, "objective must be updated");

		const disk = readActiveGoalText(ctx, updated);
		assert.ok(disk.includes(newObj), "disk must have new objective");
		assert.ok(disk.includes('"status": "paused"'), "disk must show paused status");
	} finally {
		cleanupGoalContext(ctx);
	}
});

// ── 8. Deferred archival after sync (fully sequential) ────────────────────────
// Sync objective → mark complete → not archived → archiveGoalFile → archived.

test("deferred archival after sync: verify active then archived", () => {
	const ctx = createTempGoalContext(TEST_PREFIX);
	try {
		const updatedObj = "Objective updated before completion";
		const active = writeActiveGoalFile(ctx, makeGoal({ objective: "Original" }));

		// Sync, then mark complete (deferred archival)
		const synced = writeActiveGoalFile(ctx, { ...active, objective: updatedObj });
		assert.equal(synced.archivedPath, undefined);
		const completed = completeGoalOnDisk(ctx, synced);
		assert.match(completed.activePath ?? "", /^\.pi\/goals\/active_goal_/,
			"after mark complete: still active file (not archived)");
		assert.equal(completed.archivedPath, undefined,
			"after mark complete: no archivedPath");

		// Pool should filter it out (readActiveGoalPool skips complete)
		const pool = readActiveGoalPool(ctx);
		assert.equal(pool.has(active.id), false, "complete goal filtered from pool");

		// Now archive (turn_end)
		const archived = archiveCompletedGoal(ctx, completed);
		assert.equal(archived.activePath, undefined, "after archive: no activePath");
		assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/,
			"after archive: has archivedPath");

		const archivedContent = readArchivedGoalText(ctx, archived);
		assert.ok(archivedContent.includes(updatedObj),
			"archived file must have the synced objective");
		assert.ok(archivedContent.includes('"status": "complete"'),
			"archived file must have complete status");
	} finally {
		cleanupGoalContext(ctx);
	}
});

// ── 9. All three bypass paths (no sync) — separate tools already covered ──────
// This test verifies all three produce distinct reports and that goal
// archival is consistent regardless of which bypass was taken.

test("all three bypass paths produce correct distinct reports", () => {
	const base = "Base detailed summary";

	const approval = buildCompletionReport({
		detailedSummary: base,
		completionSummary: "Approval test.",
		auditorReport: "All verified.\n\n<approved/>",
	});
	const disabled = buildCompletionReport({
		detailedSummary: base,
		completionSummary: "Disabled test.",
		auditSkippedReason: "auditor disabled in settings",
	});
	const esc = buildCompletionReport({
		detailedSummary: base,
		completionSummary: "Esc test.",
		auditSkippedReason: "auditor bypassed (user pressed Escape during audit)",
	});

	assertIncludesAll(approval, ["Goal audit approved.", "<approved/>", "Goal complete."]);
	assertIncludesAll(disabled, ["Goal audit skipped.", "auditor disabled in settings", "Goal complete."]);
	assertIncludesAll(esc, ["Goal audit skipped.", "auditor bypassed (user pressed Escape during audit)", "Goal complete."]);
	assertExcludesAll(disabled, ["<approved/>"]);
	assertExcludesAll(esc, ["<approved/>"]);

	// Verify archival same for all — simulate by having each pass through
	// writeActiveGoalFile + archiveGoalFile with a fresh goal each time
	for (const label of ["approval", "disabled", "esc"]) {
		const ctx = createTempGoalContext(TEST_PREFIX);
		try {
			const goal = makeGoal({ objective: `Bypass test: ${label}` });
			const active = writeActiveGoalFile(ctx, goal);
			assert.equal(active.objective, `Bypass test: ${label}`);

			const completed = completeGoalOnDisk(ctx, active);
			assert.equal(completed.status, "complete");
			assert.equal(completed.archivedPath, undefined);

			const archived = archiveCompletedGoal(ctx, completed);
			assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/);
			assert.ok(readArchivedGoalText(ctx, archived).includes(`Bypass test: ${label}`),
				`${label}: archived has correct objective`);
		} finally {
			cleanupGoalContext(ctx);
		}
	}
});

// ── 10. Edge: Cannot update complete goal (handler gate test) ─────────────────

test("validateGoalUpdate rejects complete goal", () => {
	assertRejectsCompleteGoalUpdate(makeGoal({ status: "complete" } as GoalRecord));
});

test("validateGoalUpdate rejects null goal (no goal exists)", () => {
	assertRejectsMissingGoalUpdate();
});

test("validateGoalUpdate accepts active and paused goals", () => {
	assertAllowsGoalUpdate(makeGoal());
	assertAllowsGoalUpdate(makeGoal({ status: "paused" }));
});
