import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createGoalCompletionRuntime, type CompletionReportVariant } from "../extensions/goal-completion-runtime.ts";
import { archiveGoalFile, writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import type { GoalRecord, GoalStateEntry } from "../extensions/goal-record.ts";
import { assertExcludesAll, assertIncludesAll } from "./helpers/assertions.ts";
import {
	cleanupGoalContext,
	createTempGoalContext,
	createTestGoal,
	type TestContext,
} from "./helpers/goal-test-helpers.ts";

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return createTestGoal({
		objective: "Finalizer operation test goal",
		at: Date.UTC(2026, 5, 7, 9, 0, 0),
		overrides,
	});
}

function archiveHasGoal(ctx: TestContext, goalId: string): boolean {
	const archiveDir = path.join(ctx.cwd, ".pi", "goals", "archived");
	if (!existsSync(archiveDir)) return false;
	return readdirSync(archiveDir).some((name) => name.includes(goalId));
}

function finalizeWithVariant(ctx: TestContext, goal: GoalRecord, variant: CompletionReportVariant, completionSummary?: string): {
	goal: GoalRecord;
	stateEntry: GoalStateEntry | undefined;
	turnStoppedFor: string | null;
	report: string;
} {
	let stateGoal: GoalRecord | null = goal;
	let stateEntry: GoalStateEntry | undefined;
	let turnStoppedFor: string | null = null;
	const runtime = createGoalCompletionRuntime({
		getGoal: () => stateGoal,
		setGoal: (next) => { stateGoal = next; },
		writeActiveGoalFile,
		archiveGoalFile,
		appendStateEntry: (next) => { stateEntry = { version: 3, goal: next }; },
		appendFocusEntry: () => {},
		appendGoalCompletedEvent: () => {},
		accountProgress: () => {},
		clearAuditProgress: () => {},
		invalidateGoalWidget: () => {},
		setTurnStoppedFor: (goalId) => { turnStoppedFor = goalId; },
		resetGetGoalNudgeState: () => {},
		removeGoalFromPool: () => {},
		clearFocus: () => { stateGoal = null; },
		syncGoalTools: () => {},
		updateUI: () => {},
		detailedSummary: (next) => `Goal: ${next?.objective ?? "none"}\nStatus: ${next?.status ?? "none"}`,
	});
	const result = runtime.finalizeGoalCompletion(ctx as any, { goal, variant, completionSummary });
	assert.ok(stateGoal, "finalizer leaves completed goal focused before archival");
	const report = (result.content[0] as { text?: string } | undefined)?.text ?? "";
	return { goal: stateGoal, stateEntry, turnStoppedFor, report };
}

test("finalizer marks the goal complete with stopReason agent and writes the active file", () => {
	const ctx = createTempGoalContext("goal-finalize-test-");
	try {
		const active = writeActiveGoalFile(ctx, makeGoal());
		const { goal: completed } = finalizeWithVariant(ctx, active, {
			auditSkippedReason: "auditor disabled in settings",
		});

		assert.equal(completed.status, "complete");
		assert.equal(completed.stopReason, "agent");
		assert.notEqual(completed.updatedAt, active.updatedAt, "updatedAt must be refreshed");
		assert.match(completed.activePath ?? "", /^\.pi\/goals\/active_goal_/);
		assert.equal(completed.archivedPath, undefined);
		const diskContent = path.join(ctx.cwd, completed.activePath ?? "missing");
		assert.ok(existsSync(diskContent), "active file must exist after the finalizer");
	} finally {
		cleanupGoalContext(ctx);
	}
});

test("finalizer produces the STATE_ENTRY payload and sets turnStoppedFor", () => {
	const ctx = createTempGoalContext("goal-finalize-test-");
	try {
		const active = writeActiveGoalFile(ctx, makeGoal());
		const { goal: completed, stateEntry, turnStoppedFor } = finalizeWithVariant(ctx, active, {
			auditSkippedReason: "auditor disabled in settings",
		});

		assert.equal(stateEntry?.version, 3);
		assert.equal(stateEntry?.goal?.id, completed.id);
		assert.equal(stateEntry?.goal?.status, "complete");
		assert.equal(stateEntry?.goal?.stopReason, "agent");
		assert.equal(turnStoppedFor, completed.id);
	} finally {
		cleanupGoalContext(ctx);
	}
});

test("finalizer does NOT archive: archival is deferred to turn_end", () => {
	const ctx = createTempGoalContext("goal-finalize-test-");
	try {
		const active = writeActiveGoalFile(ctx, makeGoal());
		const { goal: completed } = finalizeWithVariant(ctx, active, {
			auditorReport: "All verified.\n\n<approved/>",
		});

		assert.equal(completed.archivedPath, undefined, "finalizer must not set archivedPath");
		assert.match(completed.activePath ?? "", /^\.pi\/goals\/active_goal_/);
		assert.ok(existsSync(path.join(ctx.cwd, completed.activePath ?? "missing")), "active file must exist after the finalizer");
		assert.equal(archiveHasGoal(ctx, completed.id), false, "no archived file should exist for the goal after the finalizer");
	} finally {
		cleanupGoalContext(ctx);
	}
});

test("finalizer reports the disabled, Esc, and approved variants", () => {
	const ctx = createTempGoalContext("goal-finalize-test-");
	try {
		const disabled = finalizeWithVariant(ctx, writeActiveGoalFile(ctx, makeGoal({ id: "disabled-report" })), { auditSkippedReason: "auditor disabled in settings" }, "Disabled.").report;
		assertIncludesAll(disabled, ["Goal audit skipped.", "auditor disabled in settings", "Goal complete."]);
		assertExcludesAll(disabled, ["<approved/>"]);

		const esc = finalizeWithVariant(ctx, writeActiveGoalFile(ctx, makeGoal({ id: "esc-report" })), { auditSkippedReason: "auditor bypassed (user pressed Escape during audit)" }, "Esc.").report;
		assertIncludesAll(esc, ["Goal audit skipped.", "auditor bypassed (user pressed Escape during audit)", "Goal complete."]);
		assertExcludesAll(esc, ["<approved/>"]);

		const auditorOutput = "Auditor: every requirement is met.\n\n<approved/>";
		const approved = finalizeWithVariant(ctx, writeActiveGoalFile(ctx, makeGoal({ id: "approved-report" })), { auditorReport: auditorOutput }, "Approved.").report;
		assertIncludesAll(approved, ["Goal audit approved.", auditorOutput, "<approved/>", "Goal complete."]);
	} finally {
		cleanupGoalContext(ctx);
	}
});
