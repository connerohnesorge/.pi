## MODIFIED Requirements

### Requirement: Pure Agent Management Planner

The subagents extension SHALL plan list, get, create, update, and delete agent and chain management operations through a pure planner that can be tested without writing, renaming, or deleting agent files.

#### Scenario: Planning create and update validation without filesystem effects

- WHEN a management request supplies a config object, discovered catalog facts, directory facts, warning facts, and path-existence facts
- THEN the planner validates scope, name, package, target identity, chain steps, model warnings, skill warnings, create path collisions, and rename path collisions before any filesystem write occurs

#### Scenario: Planning delete target resolution without filesystem effects

- WHEN a delete request names an agent or chain that resolves through the discovered catalog
- THEN the planner returns the target file operation and result data without deleting the file itself

#### Scenario: Planning list and get without output formatting

- WHEN list or get requests are planned against discovered catalog facts
- THEN the planner returns typed result data for the output adapter to render without performing filesystem operations

### Requirement: Management Executor Compatibility

The subagents extension SHALL preserve the existing management tool executor interface and response behavior while delegating operation decisions to the planner.

#### Scenario: Existing management actions keep their output shape

- WHEN callers use list, get, create, update, delete, or doctor actions through `createAgentManagementExecutor`
- THEN the executor returns the same text/error shape while applying planned filesystem operations through adapters
