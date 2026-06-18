## Implementation Details

Introduce a pure `ChainClarifyModel` module under `src/runs/foreground/` with an interface centered on:

- current selection/editing state
- effective behavior resolution with per-step overrides
- mode-entry helpers for task/output/reads/model/thinking/skills editing
- input handlers for non-rendering transitions
- final result construction

`ChainClarifyComponent` remains the TUI adapter. It owns terminal rendering, theme formatting, notice timers, and the final `done` callback, but delegates behavior transitions to `ChainClarifyModel`.

## Context

The existing `ChainClarifyComponent` is a deep user-facing module from the caller's perspective, but its implementation has no internal seam between pure decisions and terminal IO. The interface is therefore the terminal component itself, making tests rely on rendered strings or private method access.

## Goals / Non-Goals

- Goal: make chain clarification behavior testable through a pure model interface.
- Goal: improve locality for key handling and behavior override bugs.
- Goal: preserve the existing TUI adapter interface and rendering output.
- Non-Goal: redesign the chain clarification UI or add persistent agent/chain save behavior.
- Non-Goal: change chain execution semantics outside the clarification step.

## Decisions

- Decision: Keep rendering in `chain-clarify.ts` during this change. Extracting rendering rows into a second model would broaden the PR and collide with render-progress concerns.
- Decision: Keep notice timers in the TUI adapter. Timers are terminal lifecycle behavior, while the model only reports notice-worthy events.
- Decision: Preserve current private method names where tests already reach into the component, forwarding to the model as needed.

## Risks / Trade-offs

- Risk: Moving mutable fields can break integration tests that instantiate the component directly. Mitigation: retain compatibility getters/setters or methods for existing tests.
- Risk: Pure model extraction can become a shallow pass-through. Mitigation: move state transitions and override mutation into the model, not just types.

## Migration Plan

1. Add the model module and unit tests for key state transitions.
2. Replace component-owned behavior fields with model delegation while preserving rendering output.
3. Run unit and integration tests.
