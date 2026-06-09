# Foreground Control Specification

## Requirements

### Requirement: Foreground Control Progress Mirroring

The subagents extension SHALL maintain the supervisor's live view of a running foreground
subagent (the foreground-control record) through a single shared operation that copies the
child's latest progress — activity state, last-activity time, current tool, tool-start
time, current path, turn count, tokens, and tool count — and advances the record's
`updatedAt` timestamp.

#### Scenario: Progress update mirrors the child's latest progress

- WHEN a foreground subagent emits a progress update
- THEN the foreground-control record reflects the child's current activity state, current
  tool, current path, turn count, tokens, and tool count
- AND the record's `updatedAt` advances to the update time

#### Scenario: Per-run identity is set by the caller, not the shared operation

- WHEN progress is mirrored for a chain step versus a single run
- THEN `currentAgent` and `currentIndex` are set from the calling path's own step/agent
  identity
- AND the shared progress operation does not overwrite them

### Requirement: Foreground Control Interrupt

The subagents extension SHALL wire a foreground run's interrupt through a single shared
operation, such that invoking the interrupt aborts the run exactly once, clears the
record's activity state, and advances `updatedAt`.

#### Scenario: Interrupting a running foreground subagent

- WHEN a foreground run is active and its control interrupt is invoked
- THEN the run's abort controller is aborted
- AND the interrupt returns true
- AND the control record's activity state is cleared

#### Scenario: Interrupting an already-aborted run is a no-op

- WHEN a foreground run's control interrupt is invoked after the run has already been
  aborted
- THEN no second abort is issued
- AND the interrupt returns false

### Requirement: Single Foreground Control Type

The foreground-control record SHALL be defined by one shared, exported type referenced by
every producer and consumer; no module SHALL re-declare its shape inline.

#### Scenario: Adding a mirrored progress field

- WHEN a new progress field is added to the foreground-control contract
- THEN it is declared once on the shared type and copied once in the shared progress
  operation
- AND no inline re-declaration of the control shape exists in chain execution

