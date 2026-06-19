# Change: Add workspace build coordination

## Why

The extension directory contains many independent pi packages with mixed test runners, typecheck commands, and package validation scripts. There is no single root command that can build, test, or package-check all extensions together.

## What Changes

- Add a root npm workspace manifest for the extension packages.
- Add Turborepo task orchestration for build, typecheck, test, package dry-run, and aggregate checks.
- Normalize package scripts so every extension package can participate in root-level validation without changing its runtime entrypoint.
- Add ignore rules for workspace tool artifacts.

## Impact

- Affected specs: `workspace-build-coordination` (new)
- Affected code: root `package.json`, root `turbo.json`, root package lock, `.gitignore`, and package script metadata across first-level extension packages
- Compatibility: development tooling only; pi extension runtime manifests and entrypoints remain unchanged.
