# Change: Deepen chain clarification state

## Why

The chain clarification TUI currently concentrates editing state, key transitions, model/skill selector behavior, override mutation, notice timers, and rendering in one large module. This makes behavior hard to test without rendering the terminal interface and creates poor locality for chain-editing bugs.

## What Changes

- Extract a pure chain clarification model module that owns selection state, edit-mode transitions, behavior override mutation, model/skill filtering, thinking selection, and result construction.
- Keep `ChainClarifyComponent` as the terminal adapter that renders the model and forwards key input across the TUI seam.
- Add unit tests for the model interface so key state transitions and override behavior are testable without terminal rendering.
- Preserve the existing `ChainClarifyComponent` constructor and render behavior for callers.

## Impact

- Affected specs: `chain-clarification` (new)
- Affected code: `subagents/src/runs/foreground/chain-clarify.ts`, new foreground clarification model module, unit tests
- Compatibility: behavior-preserving refactor; no user-facing command or schema changes.
