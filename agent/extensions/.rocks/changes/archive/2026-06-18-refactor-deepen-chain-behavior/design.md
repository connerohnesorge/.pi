## Implementation Details

Split `settings.ts` into three deeper modules:

- `chain-behavior.ts` — pure policy: step types, template resolution, behavior override resolution, read-only task detection, and progress suppression.
- `chain-instructions.ts` — prompt adapter: instruction text and chain-file path rendering.
- `chain-run-dir.ts` — filesystem adapter: chain directory creation/removal/cleanup, initial progress file writes, and parallel directory creation.

`settings.ts` remains as the compatibility facade and re-exports the existing interface so current callers do not need to change in this PR.

## Context

The existing module's caller interface is convenient, but its implementation combines pure decisions with filesystem effects and prompt text assembly. Separating these seams improves locality for future chain behavior changes while preserving current callers.

## Goals / Non-Goals

- Goal: concentrate pure chain behavior decisions in a testable module.
- Goal: separate prompt instruction rendering from filesystem lifecycle effects.
- Goal: preserve existing exports from `settings.ts`.
- Non-Goal: change chain template semantics, progress semantics, read-only detection text, or path layout.
- Non-Goal: change chain execution call sites beyond import compatibility.

## Risks / Trade-offs

- Risk: re-exporting through `settings.ts` can hide unused imports or circular dependencies. Mitigation: keep modules acyclic and run full unit tests.
- Risk: instruction text changes could affect child-agent behavior. Mitigation: move strings without editing content and add focused tests.

## Migration Plan

1. Extract pure chain behavior policy and tests.
2. Extract instruction rendering and run-dir filesystem adapters.
3. Convert `settings.ts` into a compatibility facade.
4. Run focused and full unit tests.
