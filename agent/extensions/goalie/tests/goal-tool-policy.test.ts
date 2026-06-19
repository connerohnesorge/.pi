import assert from "node:assert/strict";
import test from "node:test";

import {
	computeGoalActiveTools,
	evaluateGoalToolCall,
	isMeaningfulProgressToolCall,
	shouldQueueContinuationAtTurnEnd,
} from "../extensions/goal-tool-policy.ts";

test("computeGoalActiveTools exposes active lifecycle/work tools and hides direct create_goal", () => {
	const tools = computeGoalActiveTools({
		currentTools: ["create_goal", "goal_question", "custom_tool"],
		goalStatus: "active",
		goalId: "goal-1",
		confirmationActive: false,
		tweakDraftingFor: null,
	});
	for (const name of ["get_goal", "update_goal", "pause_goal", "abort_goal", "read", "bash", "edit", "write", "propose_goal_draft", "custom_tool"]) {
		assert.ok(tools.includes(name), name);
	}
	assert.equal(tools.includes("create_goal"), false, "create_goal remains hidden");
	assert.equal(tools.includes("goal_question"), false, "question tool is hidden outside drafting");
	assert.equal(tools.includes("apply_goal_tweak"), false, "tweak tool is hidden outside tweak drafting");
});

test("computeGoalActiveTools exposes question and tweak tools during matching tweak drafting", () => {
	const tools = computeGoalActiveTools({
		currentTools: [],
		goalStatus: "paused",
		goalId: "goal-1",
		confirmationActive: false,
		tweakDraftingFor: "goal-1",
	});
	assert.ok(tools.includes("get_goal"));
	assert.ok(tools.includes("apply_goal_tweak"));
	assert.ok(tools.includes("goal_question"));
	assert.ok(tools.includes("goal_questionnaire"));
	assert.equal(tools.includes("update_goal"), false, "normal lifecycle mutation tools stay hidden during tweak drafting");
});

test("isMeaningfulProgressToolCall ignores goal-file reads and echo-only bash", () => {
	assert.equal(isMeaningfulProgressToolCall("read", { path: ".pi/goals/active_goal.md" }), false);
	assert.equal(isMeaningfulProgressToolCall("read", { path: "src/file.ts" }), true);
	assert.equal(isMeaningfulProgressToolCall("bash", { command: " echo hello" }), false);
	assert.equal(isMeaningfulProgressToolCall("bash", { command: "npm test" }), true);
	assert.equal(isMeaningfulProgressToolCall("get_goal", {}), false);
});

test("evaluateGoalToolCall blocks post-stop mutations but permits get_goal", () => {
	const blocked = evaluateGoalToolCall({
		toolName: "write",
		turnStoppedFor: "goal-1",
		goalId: "goal-1",
		goalStatus: "active",
		goalAutoContinue: true,
		confirmationActive: false,
		tweakDraftingActive: false,
	});
	assert.match(blocked.blockReason ?? "", /already stopped/);

	const allowed = evaluateGoalToolCall({
		toolName: "get_goal",
		turnStoppedFor: "goal-1",
		goalId: "goal-1",
		goalStatus: "active",
		goalAutoContinue: true,
		confirmationActive: false,
		tweakDraftingActive: false,
	});
	assert.equal(allowed.blockReason, undefined);
	assert.equal(allowed.countGetGoalNudge, true);
});

test("evaluateGoalToolCall tracks meaningful work and stops non-progress auto-continue chains", () => {
	const work = evaluateGoalToolCall({
		toolName: "write",
		args: { path: "src/file.ts" },
		turnStoppedFor: null,
		goalId: "goal-1",
		goalStatus: "active",
		goalAutoContinue: true,
		confirmationActive: false,
		tweakDraftingActive: false,
	});
	assert.equal(work.goalWorkToolCalledThisTurn, true);
	assert.equal(work.resetGetGoalNudge, true);
	assert.equal(work.turnStoppedFor, undefined);

	const nonProgress = evaluateGoalToolCall({
		toolName: "goal_question",
		turnStoppedFor: null,
		goalId: "goal-1",
		goalStatus: "active",
		goalAutoContinue: true,
		confirmationActive: false,
		tweakDraftingActive: false,
	});
	assert.equal(nonProgress.goalWorkToolCalledThisTurn, false);
	assert.equal(nonProgress.turnStoppedFor, "goal-1");
});

test("shouldQueueContinuationAtTurnEnd requires a non-tool assistant turn with meaningful work", () => {
	assert.equal(shouldQueueContinuationAtTurnEnd({ assistantUsedTool: false, goalStatus: "active", goalAutoContinue: true, goalWorkToolCalledThisTurn: true }), true);
	assert.equal(shouldQueueContinuationAtTurnEnd({ assistantUsedTool: true, goalStatus: "active", goalAutoContinue: true, goalWorkToolCalledThisTurn: true }), false);
	assert.equal(shouldQueueContinuationAtTurnEnd({ assistantUsedTool: false, goalStatus: "active", goalAutoContinue: true, goalWorkToolCalledThisTurn: false }), false);
	assert.equal(shouldQueueContinuationAtTurnEnd({ assistantUsedTool: false, goalStatus: "paused", goalAutoContinue: true, goalWorkToolCalledThisTurn: true }), false);
});
