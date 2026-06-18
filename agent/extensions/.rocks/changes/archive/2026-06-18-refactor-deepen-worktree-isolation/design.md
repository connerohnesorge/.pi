## Implementation Details

Introduce a pure worktree policy module that owns deterministic worktree decisions:

- branch/path naming
- repo-relative cwd resolution
- task cwd conflict detection
- setup-hook timeout/default validation
- synthetic path normalization/validation rules
- numstat/diff summary parsing

Keep git, filesystem, setup-hook spawn, node_modules linking, patch capture, and cleanup behind a production effects adapter. Existing exported functions in `worktree.ts` remain the public interface for callers; the seam is internal so tests can exercise policy without a live repository and exercise orchestration through injected effects where useful.

## Context

`worktree.ts` currently has a small caller-facing interface but a broad implementation with direct `spawnSync` and `fs` calls throughout. The refactor should increase locality for dangerous cleanup/failure behavior without changing the user-visible worktree isolation behavior.

## Goals / Non-Goals

- Goal: concentrate pure worktree policy in a testable module.
- Goal: put git/fs/hook effects behind an adapter seam.
- Goal: preserve current worktree setup, diff, and cleanup behavior.
- Non-Goal: redesign branch naming, patch format, hook schema, or worktree lifecycle semantics.
- Non-Goal: add new worktree user features.

## Decisions

- Decision: Keep `worktree.ts` as the compatibility facade. Callers should not learn a new interface in this behavior-preserving refactor.
- Decision: Introduce the effects seam internally first. One production adapter is enough because the existing test suite already uses real temporary repositories; pure policy tests provide the second testing surface without over-abstracting callers.
- Decision: Keep setup-hook process execution in the effects adapter, but parse hook output and synthetic path policy in the pure module.

## Risks / Trade-offs

- Risk: Cleanup behavior can regress if effect calls are reordered. Mitigation: preserve the orchestration order and keep existing cleanup/failure tests passing.
- Risk: Creating too many small modules could make worktree flow harder to follow. Mitigation: use one policy module and one effects seam rather than many thin helpers.

## Migration Plan

1. Extract pure worktree policy helpers and add focused unit tests.
2. Add a production effects adapter and route orchestration through it.
3. Preserve all existing exports from `worktree.ts`.
4. Run worktree-focused and full unit tests.
