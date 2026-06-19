# Change: Complete agent management planner extraction

## Why

The prior agent-management planner extraction left create and update behavior too interleaved with the filesystem adapter. The planner should map a management request plus discovered catalog/path facts into a typed operation/result, while `agent-management.ts` applies filesystem writes/renames/deletes and formats output.

## What Changes

- Add a top-level pure `planManagementAction` interface for list, get, create, update, and delete.
- Return typed plan variants for responses and filesystem operations instead of creating/updating/deleting inline.
- Refactor `agent-management.ts` into discovery, filesystem operation adapter, and output formatting adapter.
- Add planner tests that prove create/update/delete planning happens without filesystem mutation.

## Impact

- Affected specs: `agent-management-planner`
- Affected code: `subagents/src/agents/agent-management.ts`, `subagents/src/agents/agent-management-planner.ts`, tests
- Compatibility: behavior-preserving refactor; no tool schema or intended output changes.
