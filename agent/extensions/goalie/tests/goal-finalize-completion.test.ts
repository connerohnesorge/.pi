import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildCompletionReport } from "../extensions/goal-policy.ts";
import { cloneGoal, nowIso } from "../extensions/goal-record.ts";
import { writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import type { GoalRecord, GoalStateEntry } from "../extensions/goal-record.ts";
import { assertExcludesAll, assertIncludesAll } from "./helpers/assertions.ts";
import {
	cleanupGoalContext,
	createTempGoalContext,
	createTestGoal,
	type TestContext,
} from "./helpers/goal-test-helpers.ts";

// `finalizeGoalCompletion` is a closure-local function inside `update_goal`'s
// `execute` (design Decision + ADR-0001): it mutates extension-closure locals
// (`state.goal`, `turnStoppedFor`, `auditProgress`) and is intentionally not
// exported. This test reproduces its WRITE-half sequence over the same
// primitives the finalizer composes (`writeActiveGoalFile`, the
// `goalDetails`-shaped `STATE_ENTRY`, `buildCompletionReport`) and asserts the
// finalizer contract: the in-memory complete shape, the active-file write, the
// ledger state entry, turn-stop bookkeeping, the per-variant report, and —
// critically — that the finalizer does NOT archive (archival is deferred to the
// `turn_end` hook, the sole archival site).

type CompletionReportVariant =
	| { auditSkippedReason: string }
	| { auditorReport: string };

interface FinalizeOutcome {
	goal: GoalRecord;
	stateEntry: GoalStateEntry;
	turnStoppedFor: string | null;
	report: string;
}

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return createTestGoal({
		objective: "Finalizer write-half test goal",
		at: Date.UTC(2026, 5, 7, 9, 0, 0),
		overrides,
	});
}

// Mirror of `goal.ts`'s closure-local `goalDetails(goal)`.
function goalDetails(goal: GoalRecord | null): GoalStateEntry {
	return { version: 3, goal: goal ? cloneGoal(goal) : null };
}

// Whether the archive directory holds a file for the given goal id yet.
function archiveHasGoal(ctx: TestContext, goalId: string): boolean {
	const archiveDir = path.join(ctx.cwd, ".pi", "goals", "archived");
	if (!existsSync(archiveDir)) return false;
	return readdirSync(archiveDir).some((name) => name.includes(goalId));
}

// Faithful replica of `finalizeGoalCompletion`'s WRITE half (the portion that
// does not require the live `pi`/widget handles). It returns everything the
// finalizer hands back to the closure so the full contract can be asserted.
function finalizeWriteHalf(
	ctx: TestContext,
	goal: GoalRecord,
	variant: CompletionReportVariant,
	completionSummary?: string,
): FinalizeOutcome {
	let stateGoal: GoalRecord = {
		...goal,
		status: "complete",
		stopReason: "agent",
		updatedAt: nowIso(),
	};
	stateGoal = writeActiveGoalFile(ctx, stateGoal);
	const stateEntry = goalDetails(stateGoal); // pi.appendEntry(STATE_ENTRY, ...)
	const turnStoppedFor = stateGoal?.id ?? null;
	const report = buildCompletionReport({
		detailedSummary: `Goal: ${stateGoal.objective}\nStatus: ${stateGoal.status}`,
		completionSummary,
		...variant,
	});
	return { goal: stateGoal, stateEntry, turnStoppedFor, report };
}

test("finalizer marks the goal complete with stopReason agent and writes the active file", () => {
	const ctx = createTempGoalContext("goal-finalize-test-");
	try {
		const active = writeActiveGoalFile(ctx, makeGoal());
		const { goal: completed } = finalizeWriteHalf(ctx, active, {
			auditSkippedReason: "auditor disabled in settings",
		});

		// In-memory complete shape.
		assert.equal(completed.status, "complete");
		assert.equal(completed.stopReason, "agent");
		assert.notEqual(completed.updatedAt, active.updatedAt, "updatedAt must be refreshed");

		// Active-file write: the active file on disk reflects completion.
		assert.match(completed.activePath ?? "", /^\.pi\/goals\/active_goal_/);
		const diskContent = readFileSync(path.join(ctx.cwd, completed.activePath ?? "missing"), "utf8");
		assert.ok(diskContent.includes('"status": "complete"'), "active file must record status complete");
	} finally {
		cleanupGoalContext(ctx);
	}
});

test("finalizer produces the STATE_ENTRY ledger payload and sets turnStoppedFor", () => {
	const ctx = createTempGoalContext("goal-finalize-test-");
	try {
		const active = writeActiveGoalFile(ctx, makeGoal());
		const { goal: completed, stateEntry, turnStoppedFor } = finalizeWriteHalf(ctx, active, {
			auditSkippedReason: "auditor disabled in settings",
		});

		// Ledger STATE_ENTRY: versioned snapshot of the completed goal.
		assert.equal(stateEntry.version, 3);
		assert.equal(stateEntry.goal?.id, completed.id);
		assert.equal(stateEntry.goal?.status, "complete");
		assert.equal(stateEntry.goal?.stopReason, "agent");
		assert.equal(turnStoppedFor, completed.id);
	} finally {
		cleanupGoalContext(ctx);
	}
});

test("finalizer does NOT archive: archival is deferred to turn_end", () => {
	const ctx = createTempGoalContext("goal-finalize-test-");
	try {
		const active = writeActiveGoalFile(ctx, makeGoal());
		const { goal: completed } = finalizeWriteHalf(ctx, active, {
			auditorReport: "All verified.\n\n<approved/>",
		});

		// No archive path is set by the finalizer.
		assert.equal(completed.archivedPath, undefined, "finalizer must not set archivedPath");
		// The goal still lives in the active directory, not the archive directory.
		assert.match(completed.activePath ?? "", /^\.pi\/goals\/active_goal_/);
		assert.ok(existsSync(path.join(ctx.cwd, completed.activePath ?? "missing")), "active file must exist after the finalizer");
		// And no archived copy exists yet — archival is the turn_end hook's job.
		assert.equal(archiveHasGoal(ctx, completed.id), false, "no archived file should exist for the goal after the finalizer");
	} finally {
		cleanupGoalContext(ctx);
	}
});

test("finalizer report carries the auditor-disabled reason for the disabled branch", () => {
	const ctx = createTempGoalContext("goal-finalize-test-");
	try {
		const active = writeActiveGoalFile(ctx, makeGoal());
		const { report } = finalizeWriteHalf(
			ctx,
			active,
			{ auditSkippedReason: "auditor disabled in settings" },
			"Disabled-branch completion.",
		);
		assertIncludesAll(report, ["Goal audit skipped.", "auditor disabled in settings", "Goal complete."]);
		assertExcludesAll(report, ["<approved/>"]);
	} finally {
		cleanupGoalContext(ctx);
	}
});

test("finalizer report carries the Esc-bypass reason for the Esc-skip branch", () => {
	const ctx = createTempGoalContext("goal-finalize-test-");
	try {
		const active = writeActiveGoalFile(ctx, makeGoal());
		const { report } = finalizeWriteHalf(
			ctx,
			active,
			{ auditSkippedReason: "auditor bypassed (user pressed Escape during audit)" },
			"Esc-branch completion.",
		);
		assertIncludesAll(report, ["Goal audit skipped.", "auditor bypassed (user pressed Escape during audit)", "Goal complete."]);
		assertExcludesAll(report, ["<approved/>"]);
	} finally {
		cleanupGoalContext(ctx);
	}
});

test("finalizer report carries the auditor output for the approved branch", () => {
	const ctx = createTempGoalContext("goal-finalize-test-");
	try {
		const active = writeActiveGoalFile(ctx, makeGoal());
		const auditorOutput = "Auditor: every requirement is met.\n\n<approved/>";
		const { report } = finalizeWriteHalf(
			ctx,
			active,
			{ auditorReport: auditorOutput },
			"Approved-branch completion.",
		);
		assertIncludesAll(report, ["Goal audit approved.", auditorOutput, "<approved/>", "Goal complete."]);
	} finally {
		cleanupGoalContext(ctx);
	}
});
