## ADDED Requirements

### Requirement: Root Workspace Task Coordination

The workspace SHALL provide root commands that coordinate build, typecheck, test, package dry-run, and aggregate check tasks across first-level pi extension packages.

#### Scenario: Running all package checks

- WHEN a developer runs the root aggregate check command
- THEN the build tool executes each extension package's `check` script through the workspace orchestrator
- AND packages without direct runtime build output remain valid participants through their package-level check script.

#### Scenario: Running focused package tasks

- WHEN a developer runs a root task with a Turborepo package filter
- THEN only the selected extension package and required dependency tasks are considered
- AND the command uses the same package scripts as the all-package run.

### Requirement: Package Validation Script Contract

Each extension package SHALL expose a package-level dry-run packaging script and an aggregate check script that preserves that package's existing validation semantics.

#### Scenario: Package dry-run validation

- WHEN the workspace package dry-run task is executed
- THEN every extension package with a workspace manifest runs `npm pack --dry-run`
- AND the dry-run validates the files that would be published for pi package installation.

#### Scenario: Existing package-specific checks are preserved

- WHEN a package already has typecheck, test, build, or bundle-check behavior
- THEN its aggregate check script continues to run that behavior
- AND the workspace orchestration does not replace package-specific validation with a weaker generic command.
