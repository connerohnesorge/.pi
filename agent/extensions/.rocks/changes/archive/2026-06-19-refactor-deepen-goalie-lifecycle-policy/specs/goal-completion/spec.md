## MODIFIED Requirements

### Requirement: Single-Sourced Goal Completion

The goalie extension SHALL mark a focused goal complete through one shared lifecycle finalizer operation that performs the in-memory completion, active-file write, ledger state entry, turn-stop bookkeeping, tool resynchronization, and UI update — regardless of which `update_goal` branch (auditor disabled, auditor bypassed via Escape, or auditor approved) triggers completion.

#### Scenario: Completion via the auditor-disabled branch

- WHEN `update_goal` completes a goal with the auditor disabled
- THEN the goal is marked `complete` with `stopReason` "agent" in memory and in the active file
- AND the completion report is returned with the auditor-disabled reason
- AND the same lifecycle finalizer sequence runs as for every other completion branch

#### Scenario: Completion via the auditor-approved branch

- WHEN `update_goal` completes a goal after the auditor approves
- THEN the goal is marked `complete` through the same lifecycle finalizer operation
- AND the completion report carries the auditor's report output
- AND no second, divergent completion code path exists

#### Scenario: Only the report variant differs per branch

- WHEN any of the three completion branches runs
- THEN the only per-branch difference is the completion-report argument (`auditSkippedReason` versus `auditorReport`)
- AND all other completion effects are identical

### Requirement: Deferred Archival Fires Once at Turn End

Completion SHALL be two-phase: the finalizer writes the goal complete WITHOUT archiving, and the `turn_end` hook archives the completed goal exactly once through the shared lifecycle archival operation when it is `complete` and not yet archived, so the agent can observe the auditor result before archival.

#### Scenario: Finalizer does not archive

- WHEN the completion finalizer runs
- THEN the goal is written complete to its active file
- AND the goal is NOT archived during `update_goal`

#### Scenario: Turn end archives the completed goal once

- WHEN a turn ends and the focused goal is `complete` without an archive path
- THEN the lifecycle archival operation archives the goal file, removes it from the active pool, clears focus, and appends a `goal_completed` ledger event
- AND a subsequent turn end does not re-archive it

#### Scenario: Generic persistence does not archive completed goals

- WHEN generic goal persistence runs while a completed-but-not-archived goal is still visible before turn end
- THEN it preserves the deferred active-file state and does not archive the goal
