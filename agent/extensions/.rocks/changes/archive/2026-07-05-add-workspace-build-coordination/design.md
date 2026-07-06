## Implementation Details

- Use a root npm workspace because every extension already has an npm `package.json` and pi packages are npm-distributed.
- Use Turborepo as the coordinator rather than a bundler: source-first pi extensions keep running from their TypeScript/JavaScript entrypoints, while packages that already emit output keep their local build script.
- Keep package scripts authoritative. The root build tool schedules tasks; package-level scripts define what validation means for that extension.

## Context

The directory currently contains multiple independent pi extension packages with heterogeneous tooling: Bun tests, Vitest, Node's built-in test runner, TypeScript typechecking, and package-specific bundle checks.

## Goals / Non-Goals

- Goals: add one root entrypoint for coordinated validation; preserve per-package runtime manifests; support filtered package runs.
- Non-Goals: migrate test runners, bundle all extensions, publish packages, or collapse existing per-package lockfiles/dependencies.

## Decisions

- Decision: choose Turborepo plus npm workspaces for task orchestration.
- Alternatives considered: plain Make/Just scripts are simpler but lack package filtering and cache awareness; Nx is more capable but heavier than this source-first extension workspace needs.

## Risks / Trade-offs

- Root workspace lockfiles can surface dependency drift across packages. Mitigation: keep package-level lockfiles and avoid dependency unification in this change.
- Aggregate checks may expose pre-existing package metadata drift. Mitigation: fix script/manifest drift directly when it blocks coordinated validation.

## Migration Plan

Developers can continue running package-local commands. New root commands are additive: `npm run check`, `npm run build`, `npm run test`, `npm run typecheck`, and `npm run pack:dry`.

## Open Questions

- None.

## ADRs

### ADR-0001: Turborepo coordinates package scripts without bundling extensions

The workspace will use Turborepo only to schedule and cache package scripts. Pi already supports source-loaded TypeScript extensions, and several packages intentionally have no emitted build artifacts. Bundling every extension would add distribution and runtime risk without solving the coordination problem.
