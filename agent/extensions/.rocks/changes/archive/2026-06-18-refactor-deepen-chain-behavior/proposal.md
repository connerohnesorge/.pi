# Change: Deepen chain behavior policy

## Why

`shared/settings.ts` currently mixes chain behavior resolution, template defaults, read-only progress suppression, prompt instruction construction, chain directory lifecycle, progress-file writes, and parallel directory creation. That gives one module several unrelated reasons to change and makes pure chain behavior hard to test without filesystem concerns.

## What Changes

- Extract pure chain behavior policy into a focused module for step shapes, template resolution, behavior overrides, and read-only progress suppression.
- Extract chain instruction rendering into a separate prompt adapter module.
- Extract chain run-directory/progress filesystem lifecycle into a separate adapter module.
- Keep `settings.ts` as a compatibility facade that preserves existing exports.
- Add focused tests for pure behavior and instruction/run-dir seams.

## Impact

- Affected specs: `chain-behavior-policy` (new)
- Affected code: `subagents/src/shared/settings.ts`, new shared chain behavior/instruction/run-dir modules, unit tests
- Compatibility: behavior-preserving refactor; no chain parameter or result shape changes.
