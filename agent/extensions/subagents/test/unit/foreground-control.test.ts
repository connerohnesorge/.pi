import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	applyProgressToForegroundControl,
	clearControlInterrupt,
	markControlStart,
	wireForegroundInterrupt,
	type ForegroundControl,
} from "../../src/runs/foreground/foreground-control.ts";
import type { AgentProgress } from "../../src/shared/types.ts";

function makeControl(overrides: Partial<ForegroundControl> = {}): ForegroundControl {
	return {
		runId: "run-1",
		mode: "single",
		startedAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function makeProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		agent: "alice",
		status: "running",
		task: "do work",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		...overrides,
	};
}

describe("markControlStart", () => {
	it("sets the caller-derived head, clears activity, and bumps updatedAt", () => {
		const control = makeControl({ updatedAt: 0, currentActivityState: "active_long_running" });
		const before = Date.now();
		markControlStart(control, "bob", 3);
		assert.equal(control.currentAgent, "bob");
		assert.equal(control.currentIndex, 3);
		assert.equal(control.currentActivityState, undefined);
		assert.ok(control.updatedAt >= before, "updatedAt should advance to the start time");
	});
});

describe("applyProgressToForegroundControl", () => {
	it("mirrors the progress tail and bumps updatedAt", () => {
		const control = makeControl({ updatedAt: 0 });
		const progress = makeProgress({
			activityState: "needs_attention",
			lastActivityAt: 1234,
			currentTool: "read",
			currentToolStartedAt: 5678,
			currentPath: "src/index.ts",
			turnCount: 7,
			tokens: 4242,
			toolCount: 9,
		});
		const before = Date.now();
		applyProgressToForegroundControl(control, progress);
		assert.equal(control.currentActivityState, "needs_attention");
		assert.equal(control.lastActivityAt, 1234);
		assert.equal(control.currentTool, "read");
		assert.equal(control.currentToolStartedAt, 5678);
		assert.equal(control.currentPath, "src/index.ts");
		assert.equal(control.turnCount, 7);
		assert.equal(control.tokens, 4242);
		assert.equal(control.toolCount, 9);
		assert.ok(control.updatedAt >= before, "updatedAt should advance to the update time");
	});

	it("does not overwrite the caller-owned head (currentAgent/currentIndex)", () => {
		const control = makeControl({ currentAgent: "alice", currentIndex: 2 });
		applyProgressToForegroundControl(control, makeProgress({ agent: "someone-else", index: 99 }));
		assert.equal(control.currentAgent, "alice");
		assert.equal(control.currentIndex, 2);
	});

	it("clears the tail when progress is undefined", () => {
		const control = makeControl({
			currentActivityState: "needs_attention",
			lastActivityAt: 10,
			currentTool: "read",
			currentToolStartedAt: 20,
			currentPath: "x",
			turnCount: 1,
			tokens: 2,
			toolCount: 3,
		});
		applyProgressToForegroundControl(control, undefined);
		assert.equal(control.currentActivityState, undefined);
		assert.equal(control.lastActivityAt, undefined);
		assert.equal(control.currentTool, undefined);
		assert.equal(control.currentToolStartedAt, undefined);
		assert.equal(control.currentPath, undefined);
		assert.equal(control.turnCount, undefined);
		assert.equal(control.tokens, undefined);
		assert.equal(control.toolCount, undefined);
	});
});

describe("wireForegroundInterrupt", () => {
	it("aborts the controller once, clears activity, bumps updatedAt, and returns true", () => {
		const control = makeControl({ updatedAt: 0, currentActivityState: "active_long_running" });
		const controller = new AbortController();
		wireForegroundInterrupt(control, controller);
		// Wiring itself clears activity and bumps updatedAt.
		assert.equal(control.currentActivityState, undefined);
		assert.ok(control.updatedAt >= 0);
		assert.equal(typeof control.interrupt, "function");

		control.currentActivityState = "needs_attention";
		const before = Date.now();
		const first = control.interrupt!();
		assert.equal(first, true, "first interrupt should abort and return true");
		assert.equal(controller.signal.aborted, true);
		assert.equal(control.currentActivityState, undefined, "interrupt clears activity state");
		assert.ok(control.updatedAt >= before, "interrupt bumps updatedAt");
	});

	it("returns false and does not re-abort when already aborted", () => {
		const control = makeControl();
		const controller = new AbortController();
		wireForegroundInterrupt(control, controller);
		assert.equal(control.interrupt!(), true);

		let abortCount = 0;
		controller.signal.addEventListener("abort", () => {
			abortCount++;
		});
		const second = control.interrupt!();
		assert.equal(second, false, "second interrupt is a no-op returning false");
		assert.equal(abortCount, 0, "no second abort is issued");
	});
});

describe("clearControlInterrupt", () => {
	it("detaches the interrupt handle to undefined", () => {
		const control = makeControl();
		wireForegroundInterrupt(control, new AbortController());
		assert.equal(typeof control.interrupt, "function");
		clearControlInterrupt(control);
		assert.equal(control.interrupt, undefined);
	});
});
