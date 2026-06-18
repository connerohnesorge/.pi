# Change: Deepen worktree isolation effects

## Why

Worktree isolation currently mixes git commands, filesystem mutation, setup-hook execution, synthetic path validation, diff parsing, cleanup, and path naming in one module. That makes rollback and failure paths hard to test without real git/fs effects and spreads worktree policy across effectful implementation code.

## What Changes

- Extract pure worktree policy helpers for branch/path naming, cwd conflict detection, synthetic path validation, hook-output parsing, and diff-stat summarization.
- Introduce an injectable worktree effects adapter that owns git, filesystem, hook, and cleanup effects behind one seam.
- Keep existing exported worktree functions and behavior compatible for callers.
- Add unit coverage for the pure policy interface and adapter-driven failure/cleanup behavior.

## Impact

- Affected specs: `worktree-isolation` (new)
- Affected code: `subagents/src/runs/shared/worktree.ts`, new shared worktree policy/effects modules, unit tests
- Compatibility: behavior-preserving refactor; no change to worktree CLI/tool parameters or result shape.
