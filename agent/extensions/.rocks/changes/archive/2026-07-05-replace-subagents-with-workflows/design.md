## Implementation Details

Implement a clean local workflow extension in the existing `subagents` package path rather than depending on `@quintinshaw/pi-dynamic-workflows` at runtime.

Core modules:
- `workflow.ts`: parse/validate workflow scripts, run them in a deterministic Node `vm`, expose `agent`, `parallel`, `pipeline`, `phase`, quality helpers, and checkpoint gates.
- `agent.ts`: create isolated Pi SDK sessions for each `agent()` call, apply model/tool/agent-type routing, return text or validated structured output, and report usage/history.
- `manager.ts`: manage foreground/background runs, journal completed agent calls, resume interrupted runs, and persist state.
- `storage.ts`: read/write settings, runs, journals, model tiers, and saved workflows under `~/.pi/workflows`.
- `tui.ts`: render the bordered live panel, bordered overlay navigator, detail views, and keyboard actions.
- `commands.ts`: register `/workflows`, `/workflows-trigger`, `/workflows-progress`, `/workflows-models`, `/deep-research`, `/adversarial-review`, `/multi-perspective`, `/codebase-audit`, `/effort`, and `/ultracode`.
- `index.ts`: register the tool, commands, panel, editor trigger, and result delivery.

## Context

The upstream package is MIT licensed and provides the target behavior. This implementation should use it as a behavior reference, not as a runtime dependency. The current extension workspace runs TypeScript directly through Pi/jiti and packages source files in npm.

## Goals / Non-Goals

- Goals: match upstream behavior users rely on; simplify module boundaries; preserve Pi package installability; improve TUI prominence with strong borders; keep deterministic/resumable workflow semantics.
- Non-Goals: preserve old `pi-subagents` APIs by default; support arbitrary JS imports/filesystem access from workflow scripts; add new third-party runtime dependencies beyond the minimal parser dependency already used upstream.

## Decisions

- Decision: Use Pi SDK in-memory child sessions instead of spawning `pi --mode json` for each workflow agent. This keeps subagents isolated while avoiding process-parsing code.
- Decision: Keep workflow state under `~/.pi/workflows` to avoid polluting project `.pi` directories.
- Decision: Register a visual editor wrapper only when no other extension has already taken over the editor; keep submit-time keyword triggering even in compatibility mode.
- Decision: The navigator and live panel own their borders instead of relying on Pi's default tool box, so the UI stays prominent in collapsed and overlay states.

## Risks / Trade-offs

- Replacing the old subagent API is breaking. If compatibility matters, add a thin legacy shim before accepting the change.
- Full feature parity is broad; implementation should land in testable slices, not a monolithic file.
- Node `vm` is a determinism boundary, not a security sandbox. Scripts are trusted workflow code generated in-session.

## Migration Plan

1. Land the workflow runtime behind the existing package entry point.
2. Update README/package metadata and tests to document the new `workflow` API.
3. Remove or quarantine old subagent-specific tests and docs once the replacement passes parity checks.
4. Reload Pi and validate the tool/commands in an interactive session.

## Open Questions

- Should we retain a minimal legacy `subagent` compatibility shim, or is a hard replacement preferred?
