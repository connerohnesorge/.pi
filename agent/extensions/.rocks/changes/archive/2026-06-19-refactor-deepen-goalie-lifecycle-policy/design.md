## Implementation Details

Introduce small runtime modules around existing behavior:

- `goal-completion-runtime.ts` owns `finalizeGoalCompletion` and `archiveCompletedGoalAtTurnEnd` behind injected ports for state, active/archive file writes, state entries, UI/tool refresh, accounting, and ledger events.
- `goal-objective-runtime.ts` owns authoritative objective writes for `update_goal({updatedObjective})` and `apply_goal_tweak`, including state entries, ledger events, tweak gate clearing, nudge reset, turn-stop bookkeeping, and UI/tool refresh.
- `goal-tool-policy.ts` owns pure active-tool computation, meaningful-progress classification, post-stop tool-call blocking, and turn-end continuation decisions. The pi adapter remains responsible for timers and message delivery.
- `goal-auditor-progress.ts` owns the shared auditor progress shape and duration helpers used by the auditor and widget.

## Context

The current `goal.ts` entry point is a good pi adapter but also owns several runtime state transitions. Completion has a source-shape test because the finalizer is closure-local, objective/tweak tests simulate writes, and tool policy is mostly tested as constants rather than decisions.

## Goals / Non-Goals

- Goal: make completion, objective/tweak, auditor progress, and tool policy testable through direct module interfaces.
- Goal: preserve the goal-completion spec's single shared finalizer and deferred archival semantics.
- Goal: keep timers, pi message delivery, and TUI rendering in adapters.
- Goal: make the existing `apply_goal_tweak` path reachable through a user command without changing `/goalie-edit`.
- Non-Goal: redesign goal prompts, auditor semantics, storage layout, or the user confirmation flow.
- Non-Goal: introduce a strict ACID transaction across goal files and the ledger.

## Decisions

- Decision: Keep `goal.ts` as the registration adapter. New modules receive ports instead of importing pi globals.
- Decision: Remove only the complete-goal branch from `persist()`; normal active/paused persistence remains unchanged.
- Decision: Add `/goalie-tweak [hint]` rather than repurpose `/goalie-edit`, because `/goalie-edit` is an established direct file-edit command.
- Decision: Extract pure tool policy but leave continuation timers and follow-up delivery in `goal.ts`, avoiding a hypothetical timer seam.

## Risks / Trade-offs

- Risk: Completion archival regressions can hide until turn end. Mitigation: direct runtime tests plus existing mock/fork E2E tests.
- Risk: Tool policy changes can accidentally hide or expose tools. Mitigation: pure active-tool tests and adapter smoke tests.
- Risk: Tweak command wiring changes user-facing command surface. Mitigation: additive command only; existing `/goalie-edit` behavior remains.

## Migration Plan

1. Add shared progress/tool/completion/objective modules and direct tests.
2. Replace inline logic in `goal.ts` with module calls while preserving public results.
3. Add `/goalie-tweak` command and E2E coverage for the real `apply_goal_tweak` path.
4. Run `npm run check`, `npm test`, and `npm run test:e2e`.
