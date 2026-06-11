import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import piGoalExtension from "../../extensions/goal.ts";
import {
	createGoal,
	goalFocusDetails,
	type GoalRecord,
	type GoalStateEntry,
} from "../../extensions/goal-record.ts";
import {
	readActiveGoalPool,
	writeActiveGoalFile,
} from "../../extensions/storage/goal-files.ts";

export interface MockPiHarness {
	tools: ToolDefinition[];
	lifecycleHandlers: Map<string, Function>;
	apiCalls: Array<{ type: string; data?: unknown }>;
	resetApiCalls: () => void;
	getTool: (name: string) => ToolDefinition;
}

export function createMockPiHarness(): MockPiHarness {
	const tools: ToolDefinition[] = [];
	const lifecycleHandlers = new Map<string, Function>();
	const apiCalls: Array<{ type: string; data?: unknown }> = [];
	const mockPi = {
		registerTool: (def: ToolDefinition) => { tools.push(def); },
		registerCommand: () => {},
		on: (event: string, handler: Function) => { lifecycleHandlers.set(event, handler); },
		appendEntry: (customType: string, data: unknown) => {
			apiCalls.push({ type: "appendEntry", data: { customType, data } });
		},
		registerMessageRenderer: () => {},
		sendMessage: () => {},
		getActiveTools: () => new Map(),
		setActiveTools: () => {},
		hasUI: false,
	};
	piGoalExtension(mockPi as any);

	return {
		tools,
		lifecycleHandlers,
		apiCalls,
		resetApiCalls: () => { apiCalls.length = 0; },
		getTool: (name: string) => {
			const tool = tools.find((candidate) => candidate.name === name);
			if (!tool) throw new Error(`Tool "${name}" not found`);
			return tool;
		},
	};
}

export function createMockGoalContext(cwd: string, goal: GoalRecord): ExtensionContext {
	const focusEntry = goalFocusDetails(goal.id, "created");
	const stateEntry: GoalStateEntry = { version: 3, goal };
	return {
		cwd,
		hasUI: false,
		ui: {
			notify: () => {},
			setStatus: () => {},
			setWidget: () => {},
			select: async () => null,
		},
		sessionManager: {
			getBranch: () => [
				{ type: "custom", customType: "pi-goal-focus", data: focusEntry },
				{ type: "custom", customType: "pi-goal-state", data: stateEntry },
			],
			getCwd: () => cwd,
			getSessionId: () => "test-session",
			getRoot: () => cwd,
			append: () => {},
			appendModelChange: () => {},
			appendThinkingLevelChange: () => {},
			appendCompetingWriteCheck: () => {},
			buildSessionContext: () => ({ messages: [], sessionId: "test", model: null, thinkingLevel: "medium" }),
		},
		getSystemPrompt: () => "",
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort: () => {},
	} as unknown as ExtensionContext;
}

export function createGoalFixture(options: { prefix: string; objective: string; at?: number }): {
	cwd: string;
	goal: GoalRecord;
	mockCtx: ExtensionContext;
	cleanup: () => void;
} {
	const cwd = mkdtempSync(path.join(tmpdir(), options.prefix));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });
	writeFileSync(path.join(cwd, ".pi", "goal-auditor.json"), JSON.stringify({ disabled: true }));

	const goal = createGoal({
		objective: options.objective,
		autoContinue: true,
		sisyphus: false,
	}, options.at);
	const written = writeActiveGoalFile({ cwd } as any, goal);
	const mockCtx = createMockGoalContext(cwd, written);
	return {
		cwd,
		goal: written,
		mockCtx,
		cleanup: () => { try { rmSync(cwd, { recursive: true, force: true }); } catch {} },
	};
}

export async function startGoalSession(harness: MockPiHarness, ctx: ExtensionContext): Promise<void> {
	const sessionStart = harness.lifecycleHandlers.get("session_start");
	assert.ok(sessionStart, "session_start handler must be registered");
	await sessionStart({ reason: "start" }, ctx);
}

export async function executeUpdateGoal(
	harness: MockPiHarness,
	ctx: ExtensionContext,
	params: Record<string, unknown>,
	callId = "call-1",
): Promise<any> {
	const updateGoal = harness.getTool("update_goal");
	return (updateGoal.execute as Function)(callId, params, new AbortController().signal, undefined, ctx);
}

export function assertActiveGoal(cwd: string, goalId: string, expectedObjective: string, expectedStatus = "active"): void {
	const pool = readActiveGoalPool({ cwd } as any);
	const diskGoal = pool.get(goalId);
	assert.ok(diskGoal, "goal must remain in active pool");
	assert.equal(diskGoal.objective, expectedObjective, "disk goal must have the expected objective");
	assert.equal(diskGoal.status, expectedStatus, "goal status must match expected status");
}

export function assertArchivedDirEmpty(cwd: string): void {
	const archivedDir = path.join(cwd, ".pi", "goals", "archived");
	assert.equal(readdirSync(archivedDir).length, 0, "archived dir must be empty");
}

export function readGoalFile(cwd: string, goal: GoalRecord): string {
	return readFileSync(path.join(cwd, goal.activePath ?? "missing"), "utf8");
}
