# Agent Config Specification

## Requirements

### Requirement: Single Agent-Field Schema

The subagents extension SHALL define the agent-field schema — every field's canonical name,
its frontmatter key(s) including the `skill`/`skills` alias, and the set of known fields — in
one table that the frontmatter decoder, the JSON config decoder, and the serializer all
consult. The `KNOWN_FIELDS` set SHALL be derived from that table, not maintained separately.

#### Scenario: Adding an agent field is one edit

- WHEN a new agent field is added to the schema table
- THEN it is recognized as a known field by the frontmatter decoder, the serializer, and
  `extraFields` computation
- AND no separately-maintained field list must be updated to match

#### Scenario: The skill/skills alias is defined once

- WHEN an agent frontmatter specifies `skill` or `skills`
- THEN both resolve to the same `skills` field via the schema table's frontmatter keys
- AND the alias is not re-implemented in any individual adapter

### Requirement: Single Tool-List Split

The subagents extension SHALL split and join the `mcp:`-prefixed tool list through one shared
codec used by the frontmatter decoder, the JSON config decoder, and the serializer; no
surface SHALL re-implement the `mcp:` split.

#### Scenario: mcp-prefixed tools are split once

- WHEN a tool list contains both plain tools and `mcp:`-prefixed entries
- THEN the shared codec separates them into `tools` and `mcpDirectTools` identically for every
  surface
- AND no other `mcp:` split implementation exists in the agents module

#### Scenario: Round-trip preserves the tool list

- WHEN an agent config with plain and `mcp:` tools is serialized and re-parsed
- THEN the resulting `tools` and `mcpDirectTools` match the originals

### Requirement: Behavior-Preserving Per-Surface Adapters

The three field surfaces SHALL remain distinct adapters over the shared schema, each
preserving its current source-specific behavior and field coverage. The JSON config decoder
SHALL remain narrower than the frontmatter decoder.

#### Scenario: Frontmatter decoding is unchanged

- WHEN an agent markdown file is loaded
- THEN string coercion, CSV splitting, per-field defaults, and `extraFields` are produced
  exactly as before
- AND the parsed `AgentConfig` is identical to the pre-change result

#### Scenario: JSON config surface stays narrower

- WHEN an agent is updated via a JSON config blob
- THEN only the fields the JSON decoder already accepted are applied (it still does not accept
  `interactive` or the `skill` alias)
- AND its validation error strings are unchanged

