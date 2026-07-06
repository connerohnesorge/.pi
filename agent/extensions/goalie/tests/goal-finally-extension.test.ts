import assert from "node:assert/strict";
import test from "node:test";

import {
	createGoalFixture,
	createMockPiHarness,
	executeUpdateGoal,
	startGoalSession,
} from "./e2e/helpers.ts";
import { cleanupGoalContext, createTempGoalContext } from "./helpers/goal-test-helpers.ts";

test("/finally-goalie requires a focused active or paused goal", async () => {
	const harness = createMockPiHarness();
	const ctx = createTempGoalContext("goal-finally-empty-");
	try {
		await harness.getCommand("finally-goalie")("do later", {
			cwd: ctx.cwd,
			hasUI: false,
			ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
			sessionManager: { getBranch: () => [] },
			isIdle: () => true,
			hasPendingMessages: () => false,
		} as any);
		assert.equal(harness.apiCalls.some((call) => call.type === "appendEntry" && (call.data as any)?.customType === "pi-goal-finally"), false);
	} finally {
		cleanupGoalContext(ctx);
	}
});

test("/finally-goalie sends once after deferred archival", async () => {
	const harness = createMockPiHarness();
	const f = createGoalFixture({
		prefix: "goal-finally-ext-",
		objective: "finally-goalie initial",
		at: Date.UTC(2026, 5, 26, 9, 0, 0),
	});
	try {
		await startGoalSession(harness, f.mockCtx);
		harness.resetApiCalls();

		await harness.getCommand("finally-goalie")("/goalie-set follow-up", f.mockCtx);
		let snapshots = harness.apiCalls.filter((call) => call.type === "appendEntry" && (call.data as any)?.customType === "pi-goal-finally");
		assert.equal((snapshots.at(-1)?.data as any)?.data?.items?.[0]?.text, "/goalie-set follow-up");
		assert.equal((snapshots.at(-1)?.data as any)?.data?.items?.[0]?.goalId, f.goal.id);

		await executeUpdateGoal(
			harness,
			f.mockCtx,
			{ status: "complete", completionSummary: "Done.", confirmBypassAuditor: true },
			"call-finally-complete",
		);
		const turnEnd = harness.lifecycleHandlers.get("turn_end");
		assert.ok(turnEnd, "turn_end handler must be registered");
		await turnEnd({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, f.mockCtx);

		const sent = harness.apiCalls.find((call) => call.type === "sendUserMessage");
		assert.deepEqual(sent?.data, { text: "/goalie-set follow-up", options: { deliverAs: "followUp" } });
		snapshots = harness.apiCalls.filter((call) => call.type === "appendEntry" && (call.data as any)?.customType === "pi-goal-finally");
		assert.deepEqual((snapshots.at(-1)?.data as any)?.data?.items, []);
	} finally {
		f.cleanup();
	}
});

test("/finally-goalie does not send before completion and clears on goal clear", async () => {
	const harness = createMockPiHarness();
	const f = createGoalFixture({
		prefix: "goal-finally-ext-",
		objective: "finally-goalie clear",
		at: Date.UTC(2026, 5, 26, 9, 0, 0),
	});
	try {
		await startGoalSession(harness, f.mockCtx);
		harness.resetApiCalls();

		await harness.getCommand("finally-goalie")("write summary", f.mockCtx);
		const turnEnd = harness.lifecycleHandlers.get("turn_end");
		assert.ok(turnEnd, "turn_end handler must be registered");
		await turnEnd({ message: { role: "assistant", stopReason: "stop", usage: { input: 0, output: 0 } } }, f.mockCtx);
		assert.equal(harness.apiCalls.some((call) => call.type === "sendUserMessage"), false);

		await harness.getCommand("goalie-clear")("", f.mockCtx);
		assert.equal(harness.apiCalls.some((call) => call.type === "sendUserMessage"), false);
		const snapshots = harness.apiCalls.filter((call) => call.type === "appendEntry" && (call.data as any)?.customType === "pi-goal-finally");
		assert.deepEqual((snapshots.at(-1)?.data as any)?.data?.items, []);
	} finally {
		f.cleanup();
	}
});
