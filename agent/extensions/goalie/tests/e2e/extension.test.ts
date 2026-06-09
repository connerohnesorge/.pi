/**
 * E2E tests for the pi-goal extension.
 *
 * Follows the same pattern as pi-mcp-bridge/tests/e2e/extension.test.ts:
 * loads the extension with a mock pi API, then calls tool execute handlers
 * directly with real parameters and a mock ExtensionContext that provides
 * enough of the real interface for the lifecycle to work.
 */

import { mkdirSync, rmSync, readdirSync, readFileSync, accessSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import piGoalExtension from "../../extensions/goal.ts";
import {
	createGoal,
	goalFocusDetails,
	type GoalRecord,
	type GoalFocusEntry,
	type GoalStateEntry,
} from "../../extensions/goal-record.ts";
import {
	readActiveGoalPool,
	writeActiveGoalFile,
} from "../../extensions/storage/goal-files.ts";
import type { ToolDefinition, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal mock ExtensionContext that provides:
 * - cwd for filesystem operations (readActiveGoalPool, writeActiveGoalFile, etc.)
 * - sessionManager.getBranch() returning enough entries for loadState to set focus
 * - hasUI=false to skip widget/status rendering
 * - The rest are stub methods that won't crash
 */
function createMockCtx(cwd: string, sessionEntries: unknown[]): ExtensionContext {
	return {
		cwd,
		hasUI: false,
		sessionManager: {
			getBranch: () => sessionEntries,
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

/**
 * Creates a temp directory with `.pi/goals/` and a valid goal file.
 * Returns the context needed for a test scenario.
 */
function testFixture() {
	const cwd = mkdtempSync(path.join(tmpdir(), "goal-e2e-ext-"));
	mkdirSync(path.join(cwd, ".pi", "goals", "archived"), { recursive: true });

	// Create auditor config that disables the auditor (so completion tests
	// don't try to spawn the actual auditor subprocess)
	writeFileSync(path.join(cwd, ".pi", "goal-auditor.json"), JSON.stringify({ disabled: true }));

	const goal = createGoal({
		objective: "E2E test: initial",
		autoContinue: true,
		sisyphus: false,
	}, Date.UTC(2026, 5, 26, 9, 0, 0));

	const written = writeActiveGoalFile({ cwd } as any, goal);

	// Session entries that loadState scans to resolve focus
	const focusEntry = goalFocusDetails(goal.id, "created");
	const stateEntry: GoalStateEntry = { version: 3, goal: { ...goal, activePath: written.activePath } };
	const sessionEntries = [
		{ type: "custom", customType: "pi-goal-focus", data: focusEntry },
		{ type: "custom", customType: "pi-goal-state", data: stateEntry },
	];

	const mockCtx = createMockCtx(cwd, sessionEntries);

	const cleanup = () => { try { rmSync(cwd, { recursive: true, force: true }); } catch {} };

	return { cwd, goal: written, mockCtx, cleanup };
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("Extension E2E", () => {
	const registeredTools: ToolDefinition[] = [];
	const lifecycleHandlers = new Map<string, Function>();
	let apiCalls: Array<{ type: string; data?: unknown }> = [];

	const mockPi = {
		registerTool: (def: ToolDefinition) => { registeredTools.push(def); },
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

	before(() => {
		piGoalExtension(mockPi as any);
	});

	function getTool(name: string): ToolDefinition {
		const t = registeredTools.find((t) => t.name === name);
		if (!t) throw new Error(`Tool "${name}" not found`);
		return t;
	}

	// ── 1: Quick-sync ──────────────────────────────────────────────────────
	it("e2e: quick-sync objective via update_goal handler", async () => {
		const f = testFixture();
		try {
			// Fire session_start to load state and set focusedGoalId/state.goal
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss, "session_start handler must be registered");
			await ss({ reason: "start" }, f.mockCtx);

			apiCalls = []; // reset call tracking

			const updateGoal = getTool("update_goal");
			const result = await (updateGoal.execute as Function)(
				"call-1",
				{ updatedObjective: "E2E test: quick-synced" },
				new AbortController().signal,
				undefined,
				f.mockCtx,
			);

			// Handler must not terminate for quick-sync only
			assert.ok(result, "result must be defined");
			assert.equal(result.turnStoppedFor, undefined,
				"quick-sync must NOT set turnStoppedFor");
			assert.equal(result.terminate, undefined,
				"quick-sync must NOT return terminate: true");
			assert.equal(result.content?.[0]?.text, "Goal objective updated.",
				"must respond with 'Goal objective updated.' text");

			// Verify objective changed on disk
			const pool = readActiveGoalPool({ cwd: f.cwd } as any);
			const diskGoal = pool.get(f.goal.id);
			assert.ok(diskGoal, "goal must remain in active pool");
			assert.equal(diskGoal.objective, "E2E test: quick-synced",
				"disk goal must have the updated objective");
			assert.equal(diskGoal.status, "active",
				"goal status must remain active");

			// Verify pi.appendEntry was called to persist state
			const stateEntry = apiCalls.find(
				(c) => c.type === "appendEntry" &&
					(c.data as any)?.customType === "pi-goal-state",
			);
			assert.ok(stateEntry, "must append pi-goal-state entry");
			const entryGoal = (stateEntry.data as any)?.data?.goal;
			assert.equal(entryGoal?.objective, "E2E test: quick-synced",
				"state entry must contain the updated objective");

			// Verify NO audit was triggered (no pi-goal-audit-event entry)
			const auditEntry = apiCalls.find(
				(c) => c.type === "appendEntry" &&
					(c.data as any)?.customType === "pi-goal-audit-event",
			);
			assert.equal(auditEntry, undefined,
				"quick-sync must NOT trigger an audit event");
		} finally {
			f.cleanup();
		}
	});

	// ── 2: Combined sync + complete ────────────────────────────────────────
	it("e2e: combined sync+complete applies updated objective before audit", async () => {
		const f = testFixture();
		try {
			// Fire session_start to load state
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, f.mockCtx);

			apiCalls = []; // reset

			const updateGoal = getTool("update_goal");

			// Combined call: update objective + complete
			const result = await (updateGoal.execute as Function)(
				"call-2",
				{
					updatedObjective: "E2E test: combined update",
					status: "complete",
					completionSummary: "E2E test completed successfully.",
					confirmBypassAuditor: true,
				},
				new AbortController().signal,
				undefined,
				f.mockCtx,
			);

			// Verify result is defined and contains completion details
			assert.ok(result, "result must be defined");
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("E2E test: combined update"),
				`completion text must contain the updated objective. Got: ${text}`);
			assert.ok(text.includes("Goal complete."),
				"completion text must say 'Goal complete.'");
			assert.ok(text.includes("Goal objective updated.") || text.includes("E2E test"),
				"completion text must reference the updated objective");

			// Verify file on disk: the goal should be complete but NOT archived
			// (deferred archival - still in active dir)
			const pool = readActiveGoalPool({ cwd: f.cwd } as any);
			assert.equal(pool.has(f.goal.id), false,
				"complete goal must be filtered from active pool");

			// Check the file exists on disk (activePath still set)
			const activeFile = path.join(f.cwd, f.goal.activePath ?? ".pi/goals/missing");
			const diskContent = readFileSync(activeFile, "utf8");
			assert.ok(diskContent.includes("E2E test: combined update"),
				"file on disk must contain the updated objective");
			assert.ok(diskContent.includes('"status": "complete"'),
				"file on disk must show status=complete");
		} finally {
			f.cleanup();
		}
	});

	// ── 3: Deferred archival ───────────────────────────────────────────────
	it("e2e: complete without sync produces deferred archival state", async () => {
		const f = testFixture();
		try {
			// Fire session_start
			const ss = lifecycleHandlers.get("session_start");
			assert.ok(ss);
			await ss({ reason: "start" }, f.mockCtx);

			apiCalls = [];

			const updateGoal = getTool("update_goal");

			// Complete without sync
			const result = await (updateGoal.execute as Function)(
				"call-3",
				{
					status: "complete",
					completionSummary: "E2E test deferred archival.",
					confirmBypassAuditor: true,
				},
				new AbortController().signal,
				undefined,
				f.mockCtx,
			);

			assert.ok(result, "result must be defined");

			// The activePath on disk should still exist (deferred archival)
			const activeFile = path.join(f.cwd, f.goal.activePath ?? ".pi/goals/missing");
			let activeExists = false;
			try {
				accessSync(activeFile);
				activeExists = true;
			} catch {}
			assert.ok(activeExists,
				"goal file must still exist in active dir (deferred archival)");

			// There should be NO file in archived dir yet
			const archivedDir = path.join(f.cwd, ".pi", "goals", "archived");
			const archivedFiles = readdirSync(archivedDir);
			assert.equal(archivedFiles.length, 0,
				"archived dir must be empty (deferred archival)");
		} finally {
			f.cleanup();
		}
	});

	// ── 4: Rejection gate tests ─────────────────────────────────────────────
	it("e2e: update_goal rejects null/absent goal state", async () => {
		const f = testFixture();
		try {
			// Do NOT fire session_start — state is empty
			const updateGoal = getTool("update_goal");

			const result = await (updateGoal.execute as Function)(
				"call-4",
				{ updatedObjective: "should fail" },
				new AbortController().signal,
				undefined,
				f.mockCtx,
			);

			// Without a goal, the handler should return an error message
			// (validateGoalUpdate returns message through result.content, not an exception)
			assert.ok(result, "result must be defined");
			const text = result.content?.[0]?.text ?? "";
			assert.ok(text.includes("cannot update objective") || text.includes("No goal"),
				`must reject when no goal is active. Got: ${text}`);
		} finally {
			f.cleanup();
		}
	});
});
