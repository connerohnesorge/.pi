# Goal Completion Specification

## Requirements

### Requirement: Single-Sourced Goal Completion

The goalie extension SHALL mark a focused goal complete through one shared finalizer
operation that performs the in-memory completion, active-file write, ledger state entry,
turn-stop bookkeeping, tool resynchronization, and UI update — regardless of which
`update_goal` branch (auditor disabled, auditor bypassed via Escape, or auditor approved)
triggers completion.

#### Scenario: Completion via the auditor-disabled branch

- WHEN `update_goal` completes a goal with the auditor disabled
- THEN the goal is marked `complete` with `stopReason` "agent" in memory and in the active file
- AND the completion report is returned with the auditor-disabled reason
- AND the same finalizer sequence runs as for every other completion branch

#### Scenario: Completion via the auditor-approved branch

- WHEN `update_goal` completes a goal after the auditor approves
- THEN the goal is marked `complete` through the same finalizer operation
- AND the completion report carries the auditor's report output
- AND no second, divergent completion code path exists

#### Scenario: Only the report variant differs per branch

- WHEN any of the three completion branches runs
- THEN the only per-branch difference is the completion-report argument
  (`auditSkippedReason` versus `auditorReport`)
- AND all other completion effects are identical

### Requirement: Deferred Archival Fires Once at Turn End

Completion SHALL be two-phase: the finalizer writes the goal complete WITHOUT archiving, and
the `turn_end` hook archives the completed goal exactly once when it is `complete` and not
yet archived, so the agent can observe the auditor result before archival.

#### Scenario: Finalizer does not archive

- WHEN the completion finalizer runs
- THEN the goal is written complete to its active file
- AND the goal is NOT archived during `update_goal`

#### Scenario: Turn end archives the completed goal once

- WHEN a turn ends and the focused goal is `complete` without an archive path
- THEN the goal file is archived, removed from the active pool, focus is cleared, and a
  `goal_completed` ledger event is appended
- AND a subsequent turn end does not re-archive it

### Requirement: Removal of Dead Completion-Adjacent Gates

The goalie extension SHALL NOT retain unused gate/policy exports that have no runtime caller.
The no-op and orphan helpers `validateGoalCreationSlot`, `evaluateDraftingToolGate`,
`isGoalUnfinished`, `shouldQueueContinuation`, and `GOAL_WORK_TOOL_NAMES` SHALL be removed
along with their dedicated tests.

#### Scenario: No dead gate remains

- WHEN the codebase is searched for the removed symbols outside their deleted tests
- THEN no references exist
- AND the live `GOAL_PROGRESS_TOOL_NAMES` constant and the live policy validators remain intact

#### Scenario: Live policy validators are preserved

- WHEN completion, pause, abort, and resume run
- THEN their `PolicyValidation` guards (`validateGoalUpdate`, `validateGoalCompletion`,
  `validatePauseGoal`, `validateGoalAbort`, `validateResumeGoal`) still execute
- AND user-facing rejection wording is unchanged

