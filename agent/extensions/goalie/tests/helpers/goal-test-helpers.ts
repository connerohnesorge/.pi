import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateGoalUpdate } from "../../extensions/goal-policy.ts";
import { createGoal, type GoalRecord } from "../../extensions/goal-record.ts";
import { archiveGoalFile, writeActiveGoalFile } from "../../extensions/storage/goal-files.ts";

export interface TestContext {
	cwd: string;
}

export function createTempGoalContext(prefix: string): TestContext {
	return { cwd: mkdtempSync(path.join(tmpdir(), prefix)) };
}

export function cleanupGoalContext(ctx: TestContext): void {
	try {
		rmSync(ctx.cwd, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

export function createTestGoal(options: {
	objective: string;
	at?: number;
	overrides?: Partial<GoalRecord>;
	autoContinue?: boolean;
	sisyphus?: boolean;
}): GoalRecord {
	return {
		...createGoal({
			objective: options.objective,
			autoContinue: options.autoContinue ?? true,
			sisyphus: options.sisyphus ?? false,
		}, options.at),
		...options.overrides,
	};
}

export function readActiveGoalText(ctx: TestContext, goal: GoalRecord): string {
	return readFileSync(path.join(ctx.cwd, goal.activePath ?? "missing"), "utf8");
}

export function readArchivedGoalText(ctx: TestContext, goal: GoalRecord): string {
	return readFileSync(path.join(ctx.cwd, goal.archivedPath ?? "missing"), "utf8");
}

export function completeGoalOnDisk(ctx: TestContext, goal: GoalRecord, extra: Partial<GoalRecord> = {}): GoalRecord {
	return writeActiveGoalFile(ctx, {
		...goal,
		status: "complete",
		stopReason: "agent",
		updatedAt: new Date().toISOString(),
		...extra,
	});
}

export function archiveCompletedGoal(ctx: TestContext, goal: GoalRecord): GoalRecord {
	return archiveGoalFile(ctx, goal);
}

export function assertRejectsMissingGoalUpdate(): void {
	const result = validateGoalUpdate({ goal: null });
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.match(result.message, /cannot update objective/);
		assert.match(result.message, /No goal is set/);
	}
}

export function assertRejectsCompleteGoalUpdate(goal: GoalRecord): void {
	const result = validateGoalUpdate({ goal });
	assert.equal(result.ok, false);
	if (!result.ok) {
		assert.match(result.message, /cannot update objective/);
		assert.match(result.message, /already complete/);
	}
}

export function assertAllowsGoalUpdate(goal: GoalRecord): void {
	assert.equal(validateGoalUpdate({ goal }).ok, true);
}
