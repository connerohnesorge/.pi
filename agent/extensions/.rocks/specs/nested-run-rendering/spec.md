# Nested Run Rendering Specification

## Requirements

### Requirement: Single Nested-Run Traversal

The subagents extension SHALL walk the nested-run tree for display through one shared
traversal that owns the depth cap, line budget, overflow aggregation, and per-step recursion,
with all line decoration supplied by the calling renderer.

#### Scenario: Plain-text and widget renderers share the traversal

- WHEN nested runs are rendered for a status view and for the live widget
- THEN both produce their lines through the same traversal
- AND they differ only in the decoration callbacks (plain text versus themed glyphs) and
  budget values

#### Scenario: Depth cap collapses deeper runs to an aggregate

- WHEN the nested tree is deeper than the configured maxDepth
- THEN runs beyond maxDepth are summarised by a single aggregate line
- AND the aggregate reflects the count and states of the collapsed runs

#### Scenario: Budget overflow replaces the tail with an aggregate

- WHEN the rendered lines reach the configured budget before the runs are exhausted
- THEN the last line is replaced by an aggregate of the remaining runs
- AND no further lines are emitted

### Requirement: Result Receipt Printer Remains Separate

The grouped-result intercom receipt printer SHALL remain a distinct, simpler traversal and
SHALL NOT be routed through the shared nested-run walker.

#### Scenario: Result printer is not folded into the shared walker

- WHEN a result intercom receipt lists nested subagents
- THEN it uses its own flat-budget printer over the depth-pruned public summary
- AND the shared walker's interface is not widened to accommodate it

