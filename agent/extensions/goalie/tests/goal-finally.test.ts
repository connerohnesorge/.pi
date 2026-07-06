import assert from "node:assert/strict";
import test from "node:test";

import {
	GOAL_FINALLY_CUSTOM_TYPE,
	clearGoalFinallyItems,
	dequeueGoalFinallyItem,
	parseGoalFinallyCommand,
	reconstructGoalFinallyItems,
	replaceGoalFinallyItem,
	snapshotGoalFinallyItems,
} from "../extensions/goal-finally.ts";

test("parseGoalFinallyCommand preserves raw slash commands and controls", () => {
	assert.deepEqual(parseGoalFinallyCommand(""), { kind: "status" });
	assert.deepEqual(parseGoalFinallyCommand(" --status "), { kind: "status" });
	assert.deepEqual(parseGoalFinallyCommand("--clear"), { kind: "clear" });
	assert.deepEqual(parseGoalFinallyCommand(" /goalie-set next goal\r\n"), { kind: "enqueue", text: "/goalie-set next goal" });
	assert.deepEqual(parseGoalFinallyCommand("-- --status is text"), { kind: "enqueue", text: "--status is text" });
	assert.throws(() => parseGoalFinallyCommand("--"));
});

test("goal finally reconstruction uses latest branch snapshot", () => {
	const first = snapshotGoalFinallyItems([
		{ id: "a", goalId: "goal-1", text: "first", queuedAt: 1 },
	], 10);
	const second = snapshotGoalFinallyItems([
		{ id: "b", goalId: "goal-2", text: "/goalie next", queuedAt: 2 },
	], 20);

	assert.deepEqual(reconstructGoalFinallyItems([
		{ type: "custom", customType: GOAL_FINALLY_CUSTOM_TYPE, data: first },
		{ type: "custom", customType: "other", data: first },
		{ type: "custom", customType: GOAL_FINALLY_CUSTOM_TYPE, data: second },
	]), second.items);
});

test("goal finally replacement, clear, and dequeue are keyed by goal", () => {
	let items = replaceGoalFinallyItem([], "goal-1", "first", "id-1", 1);
	items = replaceGoalFinallyItem(items, "goal-2", "second", "id-2", 2);
	items = replaceGoalFinallyItem(items, "goal-1", "replacement", "id-3", 3);

	assert.equal(items.length, 2);
	assert.equal(items.find((item) => item.goalId === "goal-1")?.text, "replacement");
	assert.equal(items.find((item) => item.goalId === "goal-2")?.text, "second");

	const dequeued = dequeueGoalFinallyItem(items, "goal-1");
	assert.equal(dequeued.item?.text, "replacement");
	assert.deepEqual(dequeued.items.map((item) => item.goalId), ["goal-2"]);

	assert.deepEqual(clearGoalFinallyItems(items, "goal-2").map((item) => item.goalId), ["goal-1"]);
	assert.deepEqual(clearGoalFinallyItems(items), []);
});
