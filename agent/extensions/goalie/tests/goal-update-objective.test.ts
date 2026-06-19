import assert from "node:assert/strict";
import test from "node:test";

import { createGoalObjectiveRuntime } from "../extensions/goal-objective-runtime.ts";
import { buildCompletionReport } from "../extensions/goal-policy.ts";
import {
	archiveGoalFile,
	readActiveGoalPool,
	writeActiveGoalFile,
} from "../extensions/storage/goal-files.ts";
import type { GoalRecord, GoalStateEntry } from "../extensions/goal-record.ts";
import {
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

const TEST_PREFIX = "goal-update-objective-test-";

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return createTestGoal({
		objective: "Original objective: build feature X",
		at: Date.UTC(2026, 5, 2, 10, 0, 0),
		overrides,
	});
}

function makeObjectiveRuntime() {
	let stateGoal: GoalRecord | null = null;
	let stateEntry: GoalStateEntry | null = null;
	let tweakDraftingCleared = false;
	let turnStoppedFor: string | null = null;
	let syncedTools = 0;
	let updatedUi = 0;
	let notified: string | null = null;
	const events: Array<{ goalId: string; changeSummary: string; at: string }> = [];
	const runtime = createGoalObjectiveRuntime({
		setGoal: (goal) => { stateGoal = goal; },
		writeActiveGoalFile,
		appendStateEntry: (goal) => { stateEntry = { version: 3, goal }; },
		appendGoalTweakedEvent: (_ctx, goal, changeSummary) => events.push({ goalId: goal.id, changeSummary, at: goal.updatedAt }),
		clearTweakDrafting: () => { tweakDraftingCleared = true; },
		resetGetGoalNudgeState: () => {},
		setTurnStoppedFor: (goalId) => { turnStoppedFor = goalId; },
		syncGoalTools: () => { syncedTools += 1; },
		updateUI: () => { updatedUi += 1; },
		notify: (_ctx, message) => { notified = message; },
	});
	return {
		runtime,
		get stateGoal() { return stateGoal; },
		get stateEntry() { return stateEntry; },
		get tweakDraftingCleared() { return tweakDraftingCleared; },
		get turnStoppedFor() { return turnStoppedFor; },
		get syncedTools() { return syncedTools; },
		get updatedUi() { return updatedUi; },
		get notified() { return notified; },
		events,
	};
}

// ─── validateGoalUpdate (handler gate) ───────────────────────────────────────

test("validateGoalUpdate rejects null goal (no goal exists)", () => {
	assertRejectsMissingGoalUpdate();
});

test("validateGoalUpdate rejects complete goal", () => {
	assertRejectsCompleteGoalUpdate(makeGoal({ status: "complete" } as GoalRecord));
});

test("validateGoalUpdate accepts active goal", () => {
	assertAllowsGoalUpdate(makeGoal());
});

test("validateGoalUpdate accepts paused goal", () => {
	assertAllowsGoalUpdate(makeGoal({ status: "paused" }));
});

// ─── update_goal({updatedObjective}) quick-sync runtime ─────────────────────

test("objective runtime updates objective in memory, state entry, ledger, UI, and disk", () => {
	const ctx = createTempGoalContext(TEST_PREFIX);
	try {
		const originalObj = "Original objective: build feature X";
		const newObj = "Updated objective: build feature Y after requirements change";

		const active = writeActiveGoalFile(ctx, makeGoal({ objective: originalObj }));
		const harness = makeObjectiveRuntime();
		const result = harness.runtime.applyObjectiveUpdate(ctx as any, active, {
			newObjective: newObj,
			changeSummary: "Objective updated via update_goal",
		});

		assert.equal(result.goal.status, "active");
		assert.equal(result.goal.objective, newObj);
		assert.equal(harness.stateGoal?.objective, newObj);
		assert.equal(harness.stateEntry?.goal?.objective, newObj);
		assert.equal(harness.events.length, 1);
		assert.equal(harness.events[0]?.changeSummary, "Objective updated via update_goal");
		assert.equal(harness.updatedUi, 1);
		assert.equal(harness.syncedTools, 1, "quick objective update resyncs tools through the runtime operation");
		assert.match(result.goal.activePath ?? "", /^\.pi\/goals\/active_goal_/);
		assert.equal(result.goal.archivedPath, undefined);

		const disk2 = readActiveGoalText(ctx, result.goal);
		assert.ok(disk2.includes(newObj));
		assert.ok(!disk2.includes(originalObj));
		assert.ok(disk2.includes('"status": "active"'));
		assert.ok(readActiveGoalPool(ctx).has(active.id));
		assert.equal(result.goal.activePath, active.activePath);
	} finally {
		cleanupGoalContext(ctx);
	}
});

// ─── combined updatedObjective + status=complete path ────────────────────────

test("combined updatedObjective + status=complete applies update before completion", () => {
	const ctx = createTempGoalContext(TEST_PREFIX);
	try {
		const originalObj = "Original objective for combined test";
		const newObj = "Updated before complete: final requirement";

		const active = writeActiveGoalFile(ctx, makeGoal({ objective: originalObj }));
		const harness = makeObjectiveRuntime();
		const updated = harness.runtime.applyObjectiveUpdate(ctx as any, active, {
			newObjective: newObj,
			changeSummary: "Objective updated via update_goal",
		}).goal;
		const combined = completeGoalOnDisk(ctx, updated, { objective: updated.objective });
		assert.equal(combined.objective, newObj);
		assert.equal(combined.status, "complete");
		assert.match(combined.activePath ?? "", /^\.pi\/goals\/active_goal_/);
		assert.equal(combined.archivedPath, undefined);

		const diskContent = readActiveGoalText(ctx, combined);
		assert.ok(diskContent.includes(newObj));
		assert.ok(diskContent.includes('"status": "complete"'));

		const archived = archiveGoalFile(ctx, combined);
		assert.equal(archived.activePath, undefined);
		assert.match(archived.archivedPath ?? "", /^\.pi\/goals\/archived\/goal_/);
		const archivedContent = readArchivedGoalText(ctx, archived);
		assert.ok(archivedContent.includes(newObj));
		assert.ok(archivedContent.includes('"status": "complete"'));
	} finally {
		cleanupGoalContext(ctx);
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

// ─── apply_goal_tweak runtime ────────────────────────────────────────────────

test("objective runtime applies goal tweak authoritatively and terminates", () => {
	const ctx = createTempGoalContext(TEST_PREFIX);
	try {
		const originalObj = "Original objective";
		const newObj = "Tweaked objective after goalie tweak interview";
		const active = writeActiveGoalFile(ctx, makeGoal({ objective: originalObj }));
		const harness = makeObjectiveRuntime();

		const result = harness.runtime.applyGoalTweak(ctx as any, active, {
			newObjective: newObj,
			changeSummary: "Clarified success criteria",
		});

		assert.equal(result.goal.objective, newObj);
		assert.equal(result.goal.status, "active");
		assert.equal(result.goal.activePath, active.activePath);
		assert.equal(result.terminate, true);
		assert.match(result.text, /Goal tweak applied/);
		assert.equal(harness.tweakDraftingCleared, true);
		assert.equal(harness.turnStoppedFor, result.goal.id);
		assert.equal(harness.syncedTools, 1);
		assert.equal(harness.updatedUi, 1);
		assert.match(harness.notified ?? "", /Clarified success criteria/);
		assert.equal(harness.events[0]?.changeSummary, "Clarified success criteria");

		const diskContent = readActiveGoalText(ctx, result.goal);
		assert.ok(diskContent.includes(newObj), "disk must have the tweaked objective");
		assert.ok(diskContent.includes('"status": "active"'), "disk must show active status");
		assert.ok(readActiveGoalPool(ctx).has(active.id), "tweaked goal must still be in active pool");
	} finally {
		cleanupGoalContext(ctx);
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
	assert.ok(contText.includes("/goalie-tweak"), "continuationPrompt must mention /goalie-tweak for broader revisions");
	assert.ok(contText.includes("/goalie-edit"), "continuationPrompt must preserve /goalie-edit as direct editing alternative");

	const goalText = goalPrompt(goal);
	assert.ok(goalText.includes("Goal evolution:"), "goalPrompt must include Goal evolution instruction");
	assert.ok(goalText.includes("updatedObjective"), "goalPrompt must reference updatedObjective");
});
