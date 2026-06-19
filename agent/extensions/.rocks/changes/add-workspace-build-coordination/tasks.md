## 1. Workspace orchestration

- [x] 1.1 Add a root npm workspace manifest that includes the first-level extension packages and exposes root build, typecheck, test, pack dry-run, and check commands.
- [x] 1.2 Add Turborepo configuration for cacheable package tasks and non-cacheable cleanup.
- [x] 1.3 Generate or update the root npm lockfile for the workspace build tool dependency.

## 2. Package script contract

- [x] 2.1 Normalize package scripts so every extension package has an aggregate `check` path and an `npm pack --dry-run` script.
- [x] 2.2 Preserve package-specific validation, including existing typecheck, test, bundle-check, and build semantics.
- [x] 2.3 Fix metadata/script drift that would prevent coordinated checks from validating the shipped extension files.

## 3. Validation

- [x] 3.1 Run the root build coordination commands or targeted equivalents to prove Turborepo discovers and executes the package tasks.
- [x] 3.2 Run package-level checks for changed script contracts where full workspace validation is too expensive or blocked by pre-existing failures.
