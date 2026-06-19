# Change: Deepen agent management planner

## Why

The agent management tool currently interleaves request parsing, validation, identity resolution, model/skill warnings, filesystem writes/renames, and response formatting in one module. This makes create/update/delete behavior hard to test without touching agent files and spreads validation locality across effectful code.

## What Changes

- Extract a pure agent management planner module for config parsing, validation, target resolution, warning construction, and operation planning.
- Keep filesystem writes, renames, deletes, and response formatting as adapters around the planner.
- Preserve the existing `createAgentManagementExecutor` interface and output behavior.
- Add tests for planner decisions without filesystem mutation.

## Impact

- Affected specs: `agent-management-planner` (new), relates to existing `agent-config`
- Affected code: `subagents/src/agents/agent-management.ts`, new planner module, unit tests
- Compatibility: behavior-preserving refactor; no changes to tool schema or management command output are intended.
