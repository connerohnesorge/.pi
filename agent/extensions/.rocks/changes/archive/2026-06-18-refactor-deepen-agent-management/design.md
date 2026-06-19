## Implementation Details

Introduce an `agent-management-planner` module that owns pure decisions:

- JSON/config object parsing
- scope/name/package validation
- create/update/delete identity checks
- chain step validation and warning construction
- operation/result planning from discovered agent/chain catalogs

`agent-management.ts` remains the executor adapter. It gathers catalogs, applies planned filesystem operations through existing serializer helpers, and formats the planner result for the tool response.

## Context

The existing management module has a small external tool interface but a large implementation that mixes pure decisions with filesystem effects. The refactor should make the interface the test surface for management decisions without broadening the caller-facing tool surface.

## Goals / Non-Goals

- Goal: improve locality for management validation and operation planning.
- Goal: make create/update/delete edge cases testable without filesystem writes.
- Goal: preserve existing tool outputs and serialized agent/chain formats.
- Non-Goal: redesign agent config schema, management command names, or discovery precedence.
- Non-Goal: change persisted file layout.

## Decisions

- Decision: keep `agent-management.ts` as the compatibility facade and effects adapter.
- Decision: the planner returns typed operations/results rather than writing files directly.
- Decision: formatting can remain in the adapter for now, but validation/warning text that affects behavior belongs in the planner.

## Risks / Trade-offs

- Risk: Moving validation can subtly change error precedence. Mitigation: keep existing tests passing and add planner tests for representative create/update/delete paths.
- Risk: Too much extraction could duplicate serializer behavior. Mitigation: planner produces domain operations; adapter still calls existing serializer modules.

## Migration Plan

1. Extract pure planner helpers and tests.
2. Route the executor through the planner while preserving output strings.
3. Run agent-management focused tests and full unit tests.
