---
name: e2e-test
description: "Run end-to-end tests for the pi-goal extension: quick-sync, combined sync+complete, and deferred archival."
---

# e2e-test

These tests verify the actual `update_goal` tool handler execution through the pi runtime using forked context (preserving the current session's goal state).

**Automated alternative**: The tests in `tests/e2e/run.ts` use `pi --mode json --fork` with `--append-system-prompt` + `--tools` to achieve deterministic behavior (the AI model is forced to make the required tool calls). No free-text AI output is parsed — only structured JSONL events (`tool_execution_start`/`tool_execution_end`).

**Manual chain**: Use this chain file for exploratory/interactive testing via `/run-chain e2e-test`.

**Source**: `tests/e2e/e2e-test.chain.md` (copy to `.pi/chains/` for use).

**Install**: `mkdir -p .pi/chains && cp tests/e2e/e2e-test.chain.md .pi/chains/e2e-test.chain.md`

## Test 1: Quick-sync

Run: `/run e2e-test-runner "Test scenario: quick-sync via update_goal({updatedObjective})`

Steps the subagent performs:
1. Get current goal state via `get_goal`
2. Call `update_goal({updatedObjective: 'e2e pass: quick-sync via handler'})`
3. Verify via `get_goal` that objective changed
4. Verify status is still "active"
5. Check disk for updated objective
6. Report PASS/FAIL

Expected result: Objective changes, status unchanged, no termination.

## Test 2: Combined sync+complete

Run: `/run e2e-test-runner "Test scenario: combined sync+complete"`

Steps the subagent performs:
1. Get current goal state via `get_goal`
2. Call `update_goal({updatedObjective: 'e2e pass: combined update', status: 'complete'})`
3. Verify completion report includes updated objective
4. Verify file on disk shows updated objective + status=complete
5. Report PASS/FAIL

Expected result: Completion report references updated objective, file shows both.

## Test 3: Deferred archival (complete without sync)

Run: `/run e2e-test-runner "Test scenario: deferred archival"`

Steps the subagent performs:
1. Get current goal state
2. Call `update_goal({status: 'complete', completionSummary: 'e2e test archival'})`
3. Verify goal is complete but NOT archived (still in active dir)
4. Note the deferred archival state
5. Report PASS/FAIL

Expected result: Status=complete but activePath still set, archivedPath not set.

---

## Results

The subagent reports structured PASS/FAIL for each test step. To inspect the goal state after the test, run `get_goal` or check `.pi/goals/`.

**Important**: The subagent runs in forked context — changes to the goal do NOT affect the parent session's goal state.
