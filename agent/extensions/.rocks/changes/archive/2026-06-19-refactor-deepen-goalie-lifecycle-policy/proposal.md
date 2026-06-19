# Change: Deepen goalie lifecycle and runtime policy

## Why

Goalie still keeps completion, objective updates, active-tool gating, turn continuation policy, and auditor progress display contracts inside the large extension adapter. This makes important Stop-gate behavior hard to test directly and leaves one current deferred-archival risk in `persist()` plus an auditor duration display bug.

## What Changes

- Extract completion finalization and turn-end archival into a focused lifecycle module with direct unit tests, and remove the generic complete-goal archival path from `persist()`.
- Extract objective update and apply-goal-tweak write operations into a focused lifecycle module, and wire prompt-driven tweak drafting through an explicit `/goalie-tweak` command while preserving `/goalie-edit` file editing.
- Extract active-tool computation and turn/tool-call policy into pure modules used by the pi adapter and tested directly.
- Share the auditor progress contract between auditor and widget rendering, fix current-tool duration units, and pin the behavior in tests.
- Add/adjust E2E coverage so quick-sync, combined completion, deferred archival, active-tool policy, and tweak application exercise the real extension path.

## Impact

- Affected specs: `goal-completion`, `goal-runtime-policy` (new)
- Affected code: `goalie/extensions/goal.ts`, new goalie runtime/policy modules, widget/auditor progress types, unit and E2E tests
- Compatibility: preserves existing tool names and `/goalie-edit`; adds `/goalie-tweak` for the already-present prompt-driven tweak flow.
