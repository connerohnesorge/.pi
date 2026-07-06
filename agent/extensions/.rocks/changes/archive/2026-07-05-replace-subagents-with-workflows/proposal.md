# Change: Replace subagents with dynamic workflows

## Why

The current `subagents` extension has grown broad and hard to reason about. We want a cleaner in-house implementation with the same user-facing workflow capabilities as `QuintinShaw/pi-dynamic-workflows`, plus a more prominent bordered TUI.

## What Changes

- BREAKING: Replace the current `pi-subagents` runtime with a dynamic-workflow runtime centered on a `workflow` tool and `/workflows` commands.
- Add deterministic JavaScript workflow execution with `agent()`, `parallel()`, `pipeline()`, `phase()`, saved workflow invocation, and quality helpers.
- Add real child Pi session execution, model tier routing, structured output, token/cost accounting, retry/timeout handling, resume journals, and optional git worktree isolation.
- Add background runs by default, result delivery back into the parent conversation, persistent run history under a user-level workflow store, and commands for status/pause/resume/stop/save/delete.
- Add a bordered, high-contrast workflow panel and navigator that are more visually prominent than the upstream implementation.
- Recreate bundled workflows such as deep research, adversarial review, multi-perspective analysis, and codebase audits.

## Impact

- Affected specs: dynamic-workflows (new); existing subagent specs become superseded by this replacement.
- Affected code: `subagents/package.json`, `subagents/src/extension/index.ts`, new workflow runtime/TUI modules under `subagents/src/`, tests under `subagents/tests/`.
- Compatibility: old `subagent`, `subagent_manage`, `subagent_control`, `/run`, `/chain`, and `/parallel` APIs are removed unless explicitly retained before implementation.
