import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
	buildGoalAuditorPrompt,
	goalAuditorConfigPath,
	loadGoalAuditorConfig,
	loadGoalAuditorFileConfig,
	parseAuditorDecision,
	parseGoalAuditorConfig,
	runGoalCompletionAuditor,
	saveGoalAuditorFileConfig,
} from "../extensions/goal-auditor.ts";
import type { GoalRecord } from "../extensions/goal-record.ts";

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
	return {
		id: "g1",
		objective: "Write a complete tutorial, not just a scaffold.",
		status: "active",
		autoContinue: true,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		createdAt: "2026-05-12T00:00:00.000Z",
		updatedAt: "2026-05-12T00:00:00.000Z",
		...overrides,
	};
}

test("parseAuditorDecision requires explicit approval and lets disapproval win", () => {
	assert.deepEqual(parseAuditorDecision("Looks good\n<approved/>"), { approved: true, disapproved: false });
	assert.deepEqual(parseAuditorDecision("Nope\n<disapproved/>"), { approved: false, disapproved: true });
	assert.deepEqual(parseAuditorDecision("confused <approved/> <disapproved/>"), { approved: false, disapproved: true });
	assert.deepEqual(parseAuditorDecision("no marker"), { approved: false, disapproved: false });
});

test("parseGoalAuditorConfig supports provider/model and thinking_level aliases", () => {
	assert.deepEqual(parseGoalAuditorConfig({ provider: "fireworks", model: "accounts/fireworks/routers/kimi", thinking_level: "high" }), {
		provider: "fireworks",
		model: "accounts/fireworks/routers/kimi",
		thinkingLevel: "high",
	});
	assert.deepEqual(parseGoalAuditorConfig({ provider: " ", model: 123, thinkingLevel: "ludicrous" }), {});
});

test("parseGoalAuditorConfig reads disabled flag", () => {
	assert.deepEqual(parseGoalAuditorConfig({ disabled: true }), { disabled: true });
	assert.deepEqual(parseGoalAuditorConfig({ disabled: "true" }), { disabled: true });
	assert.deepEqual(parseGoalAuditorConfig({ disabled: false }), {});
	assert.deepEqual(parseGoalAuditorConfig({}), {});
});

test("saveGoalAuditorFileConfig persists UI-editable auditor settings", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-test-"));
	try {
		const saved = saveGoalAuditorFileConfig(cwd, {
			provider: "fireworks",
			model: "accounts/fireworks/routers/kimi",
			thinkingLevel: "high",
		});
		assert.deepEqual(saved, {
			provider: "fireworks",
			model: "accounts/fireworks/routers/kimi",
			thinkingLevel: "high",
		});
		assert.equal(goalAuditorConfigPath(cwd), path.join(cwd, ".pi", "goal-auditor.json"));
		assert.deepEqual(loadGoalAuditorFileConfig(cwd), saved);
		assert.match(fs.readFileSync(goalAuditorConfigPath(cwd), "utf8"), /"thinking_level": "high"/);

		// Save with disabled flag
		const saved2 = saveGoalAuditorFileConfig(cwd, {
			provider: "fireworks",
			model: "accounts/fireworks/routers/kimi",
			thinkingLevel: "high",
			disabled: true,
		});
		assert.equal(saved2.disabled, true);
		assert.match(fs.readFileSync(goalAuditorConfigPath(cwd), "utf8"), /"disabled": true/);
		assert.deepEqual(loadGoalAuditorFileConfig(cwd), saved2);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("loadGoalAuditorConfig merges env and file config", () => {
	assert.equal(loadGoalAuditorConfig("/tmp", { PI_GOAL_AUDITOR_PROVIDER: "fireworks", PI_GOAL_AUDITOR_MODEL: "kimi" }).provider, "fireworks");
	// disabled is file-only, not read from env
	assert.equal(loadGoalAuditorConfig("/tmp", { PI_GOAL_AUDITOR_DISABLED: "true" }).disabled, undefined);
});

test("buildGoalAuditorPrompt demands semantic approval markers", () => {
	const prompt = buildGoalAuditorPrompt({
		goal: goal(),
		completionSummary: "Generated a VitePress scaffold and build passes.",
		detailedSummary: "Goal: tutorial",
	});
	assert.match(prompt, /independent completion auditor/);
	assert.match(prompt, /scaffold-only|alpha scaffold|generated template/);
	assert.match(prompt, /<approved\/>/);
	assert.match(prompt, /<disapproved\/>/);
	assert.match(prompt, /Generated a VitePress scaffold/);
});

test("runGoalCompletionAuditor returns aborted error when signal is already aborted (pre-flight)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-test-"));
	try {
		const ctrl = new AbortController();
		ctrl.abort(); // Already aborted before call

		let abortCalledOnSession = false;
		const mockSession = {
			abort: () => { abortCalledOnSession = true; },
			subscribe: () => () => {},
			prompt: () => { throw new Error("prompt should not be called"); },
		};

		const result = await runGoalCompletionAuditor({
			ctx: { cwd, model: undefined } as any,
			goal: goal(),
			detailedSummary: "test",
			signal: ctrl.signal,
			createSession: async () => ({ session: mockSession }) as any,
		});

		assert.equal(result.error, "Auditor aborted.");
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, true);
		assert.equal(result.output, "");
		// The signal listener for the already-aborted signal should have been
		// cleaned up in the inner finally before session.abort() could fire.
		assert.equal(abortCalledOnSession, false, "session.abort() should not be called for pre-flight abort");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("runGoalCompletionAuditor aborts running prompt when signal fires (abort during prompt)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-test-"));
	try {
		const ctrl = new AbortController();
		let abortCalledOnSession = false;
		let promptReject: (e: Error) => void;

		const mockSession = {
			abort: () => {
				abortCalledOnSession = true;
				promptReject?.(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
			},
			subscribe: () => () => {},
			prompt: () => new Promise<void>((_, reject) => { promptReject = reject; }),
		};

		const resultPromise = runGoalCompletionAuditor({
			ctx: { cwd, model: undefined } as any,
			goal: goal(),
			detailedSummary: "test",
			signal: ctrl.signal,
			createSession: async () => ({ session: mockSession }) as any,
		});

		// Yield to let the async setup run (createSession resolves, prompt is entered)
		await new Promise((r) => setTimeout(r, 0));

		// At this point prompt() should be "running" — trigger the abort
		ctrl.abort();

		const result = await resultPromise;

		assert.equal(result.error, "Auditor aborted.");
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, true);
		assert.ok(abortCalledOnSession, "session.abort() must have been called via the signal listener");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

/**
 * Validate that when session.abort() DOES NOT throw (the real agent behavior),
 * the post-prompt signal check catches the abort and returns the expected
 * "Auditor aborted." error instead of treating it as a normal (empty) result.
 */
test("runGoalCompletionAuditor detects abort when session.prompt returns normally (no throw)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-test-"));
	try {
		const ctrl = new AbortController();
		let abortCalledOnSession = false;
		let promptResolve: () => void;

		const mockSession = {
			abort: () => {
				abortCalledOnSession = true;
				// Real session.abort() calls agent.abort() then await waitForIdle().
				// The agent loop returns normally (no throw) with whatever output
				// was captured before the abort. Simulate that by resolving prompt.
				promptResolve?.();
			},
			subscribe: () => () => {},
			prompt: () => new Promise<void>((resolve) => { promptResolve = resolve; }),
		};

		const resultPromise = runGoalCompletionAuditor({
			ctx: { cwd, model: undefined } as any,
			goal: goal(),
			detailedSummary: "test",
			signal: ctrl.signal,
			createSession: async () => ({ session: mockSession }) as any,
		});

		// Yield to let createSession resolve
		await new Promise((r) => setTimeout(r, 0));

		// Abort while prompt is still running — this triggers abortSession listener
		// which calls session.abort(), which resolves the prompt.
		ctrl.abort();

		const result = await resultPromise;

		assert.equal(result.error, "Auditor aborted.");
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, true);
		assert.ok(abortCalledOnSession, "session.abort() must have been called via the signal listener");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

/**
 * Verify that the abort signal listener is properly cleaned up after a normal
 * (non-aborted) audit run resolves, preventing memory leaks.
 */
test("runGoalCompletionAuditor cleans up abort listener on normal completion", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-auditor-test-"));
	try {
		const ctrl = new AbortController();
		let abortCalledOnSession = false;

		const mockSession = {
			abort: () => { abortCalledOnSession = true; },
			subscribe: () => () => {},
			prompt: async () => {
				// Simulate a normal prompt that completes without abort
			},
		};

		const result = await runGoalCompletionAuditor({
			ctx: { cwd, model: undefined } as any,
			goal: goal(),
			detailedSummary: "test",
			signal: ctrl.signal,
			createSession: async () => ({ session: mockSession }) as any,
		});

		// Normal completion — no abort occurred, no approval/disapproval markers
		assert.equal(result.approved, false);
		assert.equal(result.disapproved, false); // Empty output has no disapproval marker
		assert.equal(result.error, undefined); // No error
		assert.equal(abortCalledOnSession, false, "session.abort() should not have been called");

		// Also verify the signal listener was cleaned up: triggering the signal after
		// completion should NOT call session.abort()
		ctrl.abort();
		assert.equal(abortCalledOnSession, false, "session.abort() should not fire after cleanup");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
