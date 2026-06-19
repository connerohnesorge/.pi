## ADDED Requirements

### Requirement: Pure Chain Behavior Policy Module

The subagents extension SHALL keep chain step/template/behavior resolution policy in a pure module that can be tested without creating directories or writing progress files.

#### Scenario: Resolving templates and behavior without filesystem effects

- WHEN a chain or parallel request supplies tasks, overrides, reads, output, progress, model, and skills values
- THEN the policy module resolves the same templates and step behavior values without touching the filesystem

#### Scenario: Suppressing progress for read-only tasks without prompt rendering

- WHEN a task text explicitly disallows file updates
- THEN the policy module disables progress for that behavior without building chain instructions or writing progress files

### Requirement: Chain Adapter Compatibility

The subagents extension SHALL preserve existing `settings.ts` exports while delegating prompt instructions and filesystem lifecycle to adapter modules.

#### Scenario: Existing callers import from settings unchanged

- WHEN foreground or background chain execution imports existing functions from `shared/settings.ts`
- THEN those imports still resolve and produce the same behavior, instruction text, and filesystem side effects as before
