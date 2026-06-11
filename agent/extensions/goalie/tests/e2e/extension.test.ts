// fallow-ignore-file code-duplication
/**
 * E2E tests for the pi-goal extension.
 *
 * Follows the same pattern as pi-mcp-bridge/tests/e2e/extension.test.ts:
 * loads the extension with a mock pi API, then calls tool execute handlers
 * directly with real parameters and a mock ExtensionContext that provides
 * enough of the real interface for the lifecycle to work.
 */

import { accessSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readActiveGoalPool } from "../../extensions/storage/goal-files.ts";
import {
	assertActiveGoal,
	assertArchivedDirEmpty,
	createGoalFixture,
	createMockPiHarness,
	executeUpdateGoal,
	readGoalFile,
	startGoalSession,
} from "./helpers.ts";

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("Extension E2E", () => {
	const harness = createMockPiHarness();

	// ── 1: Quick-sync ──────────────────────────────────────────────────────
	it("e2e: quick-sync objective via update_goal handler", async () => {
		const f = createGoalFixture({
			prefix: "goal-e2e-ext-",
			objective: "E2E test: initial",
			at: Date.UTC(2026, 5, 26, 9, 0, 0),
		});
		try {
			await startGoalSession(harness, f.mockCtx);
			harness.resetApiCalls();

			const result = await executeUpdateGoal(
				harness,
				f.mockCtx,
				{ updatedObjective: "E2E test: quick-synced" },
				"call-1",
			);

			// Handler must not terminate for quick-sync only
			assert.ok(result, "result must be defined");
			assert.equal(result.turnStoppedFor, undefined,
				"quick-sync must NOT set turnStoppedFor");
			assert.equal(result.terminate, undefined,
				"quick-sync must NOT return terminate: true");
			assert.equal(result.content?.[0]?.text, "Goal objective updated.",
				"must respond with 'Goal objective updated.' text");

			assertActiveGoal(f.cwd, f.goal.id, "E2E test: quick-synced");

			// Verify pi.appendEntry was called to persist state
			const stateEntry = harness.apiCalls.find(
				(c) => c.type === "appendEntry" &&
					(c.data as any)?.customType === "pi-goal-state",
			);
			assert.ok(stateEntry, "must append pi-goal-state entry");
			const entryGoal = (stateEntry.data as any)?.data?.goal;
			assert.equal(entryGoal?.objective, "E2E test: quick-synced",
				"state entry must contain the updated objective");

			// Verify NO audit was triggered (no pi-goal-audit-event entry)
			const auditEntry = harness.apiCalls.find(
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
		const f = createGoalFixture({
			prefix: "goal-e2e-ext-",
			objective: "E2E test: initial",
			at: Date.UTC(2026, 5, 26, 9, 0, 0),
		});
		try {
			await startGoalSession(harness, f.mockCtx);
			harness.resetApiCalls();

			// Combined call: update objective + complete
			const result = await executeUpdateGoal(
				harness,
				f.mockCtx,
				{
					updatedObjective: "E2E test: combined update",
					status: "complete",
					completionSummary: "E2E test completed successfully.",
					confirmBypassAuditor: true,
				},
				"call-2",
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
			const diskContent = readGoalFile(f.cwd, f.goal);
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
		const f = createGoalFixture({
			prefix: "goal-e2e-ext-",
			objective: "E2E test: initial",
			at: Date.UTC(2026, 5, 26, 9, 0, 0),
		});
		try {
			await startGoalSession(harness, f.mockCtx);
			harness.resetApiCalls();

			// Complete without sync
			const result = await executeUpdateGoal(
				harness,
				f.mockCtx,
				{
					status: "complete",
					completionSummary: "E2E test deferred archival.",
					confirmBypassAuditor: true,
				},
				"call-3",
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

			assertArchivedDirEmpty(f.cwd);
		} finally {
			f.cleanup();
		}
	});

	// ── 4: Rejection gate tests ─────────────────────────────────────────────
	it("e2e: update_goal rejects null/absent goal state", async () => {
		const f = createGoalFixture({
			prefix: "goal-e2e-ext-",
			objective: "E2E test: initial",
			at: Date.UTC(2026, 5, 26, 9, 0, 0),
		});
		try {
			// Do NOT fire session_start — state is empty or stale from a prior handler run.
			const result = await executeUpdateGoal(
				harness,
				f.mockCtx,
				{ updatedObjective: "should fail" },
				"call-4",
			);

			// Without a loaded goal, the handler should return an error message
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
