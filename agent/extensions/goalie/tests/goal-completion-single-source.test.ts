import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { createGoalCompletionRuntime } from "../extensions/goal-completion-runtime.ts";
import { archiveGoalFile, writeActiveGoalFile } from "../extensions/storage/goal-files.ts";
import type { GoalFocusReason, GoalRecord, GoalStateEntry } from "../extensions/goal-record.ts";
import {
	cleanupGoalContext,
	createTempGoalContext,
	createTestGoal,
	type TestContext,
} from "./helpers/goal-test-helpers.ts";

interface RuntimeHarness {
	stateGoal: GoalRecord | null;
	turnStoppedFor: string | null;
	stateEntries: GoalStateEntry[];
	focusEntries: Array<{ goalId: string | null; reason: GoalFocusReason }>;
	completedEvents: Array<{ completedGoal: GoalRecord; archivedGoal: GoalRecord }>;
	accounted: number;
	clearedAudit: number;
	invalidated: number;
	syncedTools: number;
	updatedUi: number;
	pool: Map<string, GoalRecord>;
	runtime: ReturnType<typeof createGoalCompletionRuntime>;
}

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return createTestGoal({
		objective: "Completion runtime test goal",
		at: Date.UTC(2026, 5, 7, 9, 0, 0),
		overrides,
	});
}

function createRuntimeHarness(ctx: TestContext, initial: GoalRecord | null): RuntimeHarness {
	const harness: RuntimeHarness = {
		stateGoal: initial,
		turnStoppedFor: null,
		stateEntries: [] as GoalStateEntry[],
		focusEntries: [] as Array<{ goalId: string | null; reason: GoalFocusReason }>,
		completedEvents: [] as Array<{ completedGoal: GoalRecord; archivedGoal: GoalRecord }>,
		accounted: 0,
		clearedAudit: 0,
		invalidated: 0,
		syncedTools: 0,
		updatedUi: 0,
		pool: new Map(initial ? [[initial.id, initial]] : []),
		runtime: undefined as unknown as ReturnType<typeof createGoalCompletionRuntime>,
	};
	harness.runtime = createGoalCompletionRuntime({
		getGoal: () => harness.stateGoal,
		setGoal: (goal) => {
			harness.stateGoal = goal;
			if (goal) harness.pool.set(goal.id, goal);
		},
		writeActiveGoalFile,
		archiveGoalFile,
		appendStateEntry: (goal) => harness.stateEntries.push({ version: 3, goal }),
		appendFocusEntry: (goalId, reason) => harness.focusEntries.push({ goalId, reason }),
		appendGoalCompletedEvent: (_ctx, completedGoal, archivedGoal) => harness.completedEvents.push({ completedGoal, archivedGoal }),
		accountProgress: () => { harness.accounted += 1; },
		clearAuditProgress: () => { harness.clearedAudit += 1; },
		invalidateGoalWidget: () => { harness.invalidated += 1; },
		setTurnStoppedFor: (goalId) => { harness.turnStoppedFor = goalId; },
		resetGetGoalNudgeState: () => {},
		removeGoalFromPool: (goalId) => { harness.pool.delete(goalId); },
		clearFocus: () => { harness.stateGoal = null; },
		syncGoalTools: () => { harness.syncedTools += 1; },
		updateUI: () => { harness.updatedUi += 1; },
		detailedSummary: (goal) => `Goal: ${goal?.objective ?? "none"}\nStatus: ${goal?.status ?? "none"}`,
	});
	return harness;
}

type CompletionOptions = Parameters<RuntimeHarness["runtime"]["finalizeGoalCompletion"]>[1];
type CompletionResult = ReturnType<RuntimeHarness["runtime"]["finalizeGoalCompletion"]>;

function withFinalizedGoal(options: Omit<CompletionOptions, "goal">, check: (ctx: TestContext, harness: RuntimeHarness, result: CompletionResult) => void): void {
	const ctx = createTempGoalContext("goal-completion-runtime-test-");
	try {
		const active = writeActiveGoalFile(ctx, makeGoal());
		const harness = createRuntimeHarness(ctx, active);
		check(ctx, harness, harness.runtime.finalizeGoalCompletion(ctx as any, { goal: active, ...options }));
	} finally {
		cleanupGoalContext(ctx);
	}
}

function assertCompletedGoal(harness: RuntimeHarness): GoalRecord {
	const completed = harness.stateGoal;
	assert.equal(completed?.status, "complete");
	assert.equal(completed?.stopReason, "agent");
	return completed as GoalRecord;
}

function assertCompletionSideEffects(harness: RuntimeHarness, completed: GoalRecord): void {
	assert.equal(harness.turnStoppedFor, completed.id);
	assert.equal(harness.accounted, 1);
	assert.equal(harness.clearedAudit, 1);
	assert.equal(harness.invalidated, 1);
	assert.equal(harness.syncedTools, 1);
	assert.equal(harness.updatedUi, 1);
	assert.equal(harness.stateEntries.at(-1)?.goal?.status, "complete");
}

function resultText(result: CompletionResult): string {
	return (result.content[0] as { text?: string } | undefined)?.text ?? "";
}

function assertSkippedAuditResponse(result: CompletionResult): void {
	assert.equal(result.terminate, true);
	const text = resultText(result);
	assert.match(text, /Goal audit skipped/);
	assert.match(text, /auditor disabled in settings/);
}

function assertActiveCompletionFile(ctx: TestContext, completed: GoalRecord): void {
	assert.match(completed.activePath ?? "", /^\.pi\/goals\/active_goal_/);
	assert.equal(completed.archivedPath, undefined);
	assert.ok(existsSync(path.join(ctx.cwd, completed.activePath ?? "missing")), "complete goal remains in active file before turn_end");
}

test("completion runtime finalizer marks complete, writes active file, and does not archive", () => {
	withFinalizedGoal({
		completionSummary: "Done.",
		variant: { auditSkippedReason: "auditor disabled in settings" },
	}, (ctx, harness, result) => {
		const completed = assertCompletedGoal(harness);
		assertCompletionSideEffects(harness, completed);
		assertSkippedAuditResponse(result);
		assertActiveCompletionFile(ctx, completed);
	});
});

test("completion runtime report variant carries auditor approval output", () => {
	withFinalizedGoal({
		completionSummary: "All done.",
		variant: { auditorReport: "Verified everything.\n\n<approved/>" },
	}, (_ctx, _harness, result) => {
		const text = (result.content[0] as { text?: string } | undefined)?.text ?? "";
		assert.match(text, /Goal audit approved/);
		assert.match(text, /Verified everything/);
		assert.match(text, /<approved\/>/);
	});
});

test("completion runtime archives a deferred completed goal exactly once at turn_end", () => {
	const ctx = createTempGoalContext("goal-completion-runtime-test-");
	try {
		const active = writeActiveGoalFile(ctx, makeGoal());
		const harness = createRuntimeHarness(ctx, active);
		harness.runtime.finalizeGoalCompletion(ctx as any, {
			goal: active,
			variant: { auditSkippedReason: "auditor disabled in settings" },
		});
		const completed = harness.stateGoal;
		assert.ok(completed, "completed goal exists before archive");

		const archived = harness.runtime.archiveCompletedGoalAtTurnEnd(ctx as any);
		assert.equal(archived?.completedGoal.id, completed.id);
		assert.equal(archived?.archivedGoal.activePath, undefined);
		assert.match(archived?.archivedGoal.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/);
		assert.equal(harness.stateGoal, null);
		assert.equal(harness.pool.has(completed.id), false);
		assert.deepEqual(harness.focusEntries.at(-1), { goalId: null, reason: "completed" });
		assert.equal(harness.completedEvents.length, 1);
		assert.equal(existsSync(path.join(ctx.cwd, completed.activePath ?? "missing")), false, "active file removed after archive");

		const again = harness.runtime.archiveCompletedGoalAtTurnEnd(ctx as any);
		assert.equal(again, null);
		assert.equal(harness.completedEvents.length, 1, "second turn_end does not append another completion event");
	} finally {
		cleanupGoalContext(ctx);
	}
});
