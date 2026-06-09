# Override Normalization Specification

## Requirements

### Requirement: Single Override-Input Normalizer

The subagents extension SHALL decode raw override input (the `string | boolean` output/reads
sentinels and singular `skill`) into the canonical resolved `StepOverrides` shape
(`string | false`, plural `skills`) through one shared normalizer, reused by every path that
turns task/inline overrides into resolved step behavior.

#### Scenario: Output sentinels decode once

- WHEN an override carries `output` as `true`, `"true"`, `false`, `"false"`, or a path string
- THEN `true`/`"true"` resolves to the agent's default output, `false`/`"false"` resolves to
  `false`, and a non-empty path string passes through unchanged
- AND the same decode is used by every override path, with no inline re-implementation

#### Scenario: Singular skill aliases to plural skills

- WHEN an override carries singular `skill` (string, array, or boolean)
- THEN it is normalized to the resolved `skills` field
- AND callers consume only the resolved plural form

### Requirement: Override Type Layering Preserved

The wire/parse override types (`TaskParam`, `InlineConfig`) and the resolved override types
(`StepOverrides`, `ResolvedStepBehavior`) SHALL remain distinct; normalization SHALL be the
boundary between them rather than a single merged type.

#### Scenario: Wire and resolved shapes stay separate

- WHEN override input is normalized
- THEN the wire shape retains its `string | boolean` sentinels and singular `skill`
- AND the resolved shape exposes `string | false` and plural `skills`
- AND no single type replaces both layers

