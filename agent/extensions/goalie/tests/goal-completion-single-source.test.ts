import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Grep-guard for the single-sourced completion contract (proposal
// refactor-deepen-goalie-completion). These tests read goal.ts as text and
// assert structurally that:
//   1. the in-memory "mark complete" shape + active-file write live in exactly
//      one place (`finalizeGoalCompletion`), and
//   2. the `turn_end` archive block is the sole site that archives a completed
//      goal — the finalizer itself never archives (deferred archival, ADR-0001).
// If a future edit re-scatters the completion write or moves archival into the
// finalizer, these guards fail.

const goalSource = readFileSync(
	fileURLToPath(new URL("../extensions/goal.ts", import.meta.url)),
	"utf8",
);

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

test("the in-memory completion shape exists exactly once (in finalizeGoalCompletion)", () => {
	// The object-literal completion transform `{ ...goal, status: "complete",
	// stopReason: "agent", ... }` is the heart of the finalizer; after the
	// refactor it must appear exactly once.
	assert.equal(countOccurrences(goalSource, 'status: "complete"'), 1, 'in-memory `status: "complete"` must appear exactly once');
	assert.equal(countOccurrences(goalSource, 'stopReason: "agent"'), 1, 'completion `stopReason: "agent"` must appear exactly once');

	// And that single completion shape belongs to the finalizer.
	assert.ok(goalSource.includes("function finalizeGoalCompletion("), "finalizeGoalCompletion must exist");
});

test("the completion write sequence (complete shape + writeActiveGoalFile) lives only in the finalizer", () => {
	const finalizerStart = goalSource.indexOf("function finalizeGoalCompletion(");
	assert.notEqual(finalizerStart, -1, "finalizeGoalCompletion must exist");

	// Bound the finalizer body: from its declaration to the start of the next
	// top-level marker inside execute (the "Phase 1" comment immediately follows
	// the finalizer declaration in the same scope).
	const phase1 = goalSource.indexOf("-- Phase 1: Objective update", finalizerStart);
	assert.notEqual(phase1, -1, "Phase 1 marker must follow the finalizer");
	const finalizerBody = goalSource.slice(finalizerStart, phase1);

	// The completion write sequence is inside the finalizer.
	assert.ok(finalizerBody.includes('status: "complete"'), "finalizer must contain the in-memory complete shape");
	assert.ok(finalizerBody.includes("writeActiveGoalFile(ctx, state.goal)"), "finalizer must write the active file");
	assert.ok(finalizerBody.includes("buildCompletionReport("), "finalizer must build the completion report");

	// The finalizer must NOT archive — archival is deferred to turn_end.
	assert.ok(!finalizerBody.includes("archiveGoalFile("), "finalizer must NOT archive (deferred to turn_end)");
});

test("the three completion branches all delegate to finalizeGoalCompletion", () => {
	assert.equal(
		countOccurrences(goalSource, "return finalizeGoalCompletion(ctx, auditTarget, "),
		3,
		"all three update_goal completion branches must call finalizeGoalCompletion",
	);
	// Each variant passed exactly once.
	assert.equal(countOccurrences(goalSource, '{ auditSkippedReason: "auditor disabled in settings" }'), 1, "disabled-branch variant once");
	assert.equal(countOccurrences(goalSource, '{ auditSkippedReason: "auditor bypassed (user pressed Escape during audit)" }'), 1, "Esc-branch variant once");
	assert.equal(countOccurrences(goalSource, "{ auditorReport: auditor.output }"), 1, "approved-branch variant once");
});

test("the turn_end archive block is the sole deferred-archival site for completed goals", () => {
	// The guard `state.goal?.status === "complete" && !state.goal?.archivedPath`
	// that fires the deferred archive must guard exactly one archiveGoalFile call.
	const guard = 'if (state.goal?.status === "complete" && !state.goal?.archivedPath) {';
	assert.equal(countOccurrences(goalSource, guard), 1, "the deferred-archival guard must appear exactly once (turn_end)");

	// That guarded block contains the lone completed-goal archival call.
	const guardStart = goalSource.indexOf(guard);
	assert.notEqual(guardStart, -1, "turn_end archive guard must exist");
	const guardedBlock = goalSource.slice(guardStart, guardStart + 600);
	assert.ok(guardedBlock.includes("archiveGoalFile(ctx, completedGoal)"), "turn_end guard must archive the completed goal");
	assert.ok(guardedBlock.includes('type: "goal_completed"'), "turn_end guard must append the goal_completed ledger event");
});
