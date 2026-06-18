## ADDED Requirements

### Requirement: Pure Worktree Policy Module

The subagents extension SHALL keep deterministic worktree isolation policy in a pure module that can be tested without creating git worktrees or mutating the filesystem.

#### Scenario: Synthetic path validation without filesystem effects

- WHEN hook output names synthetic paths
- THEN pure policy validates relative paths, rejects absolute or escaping paths, and preserves accepted paths for cleanup and diff filtering

#### Scenario: Diff summary parsing without git effects

- WHEN numstat and stat text are supplied to the policy module
- THEN it returns file, insertion, deletion, and display-stat values without invoking git

### Requirement: Worktree Effects Adapter Seam

The subagents extension SHALL route git, filesystem, setup-hook, and cleanup effects through a worktree effects adapter while preserving existing exported worktree behavior.

#### Scenario: Existing callers create and clean worktrees unchanged

- WHEN parallel worktree isolation calls the existing setup, diff, and cleanup functions
- THEN branch names, paths, hook behavior, patch capture, synthetic cleanup, and returned result shapes remain compatible
