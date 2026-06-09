# Slash Commands Specification

## Requirements

### Requirement: Pure Slash-Command Grammar Module

The slash-command argument grammar SHALL be implemented as a pure module that
performs no filesystem access, no agent-registry lookup, and no UI interaction.
Parsing and grammar-level validation MUST be exposed as functions that take a
raw argument string and return data (a parsed result or a typed error), so the
grammar can be exercised directly without runtime state.

#### Scenario: Grammar parses without side effects

- WHEN the grammar module parses a slash-command argument string
- THEN it returns a parsed result or a typed error value
- AND it performs no agent discovery, no UI notification, and no filesystem
  access

#### Scenario: Grammar is independently testable

- WHEN a test exercises the grammar
- THEN it MUST be able to call the parsing functions directly with a string
  argument and assert on the returned value
- AND it MUST NOT require a session, an event bus, or on-disk agent fixtures

### Requirement: Agent Token Inline Configuration

An agent token MAY carry an inline configuration block of the form
`name[key=value,...]`. The grammar SHALL parse the recognized keys `output`,
`outputMode`, `reads`, `model`, `skill`/`skills`, and `progress`, ignoring
unrecognized keys, and SHALL preserve the existing coercion rules.

#### Scenario: Inline keys are parsed

- WHEN the token `reviewer[output=notes.md,reads=a.ts+b.ts,model=opus,progress]`
  is parsed
- THEN the name is `reviewer`
- AND `output` is `"notes.md"`, `reads` is `["a.ts","b.ts"]`, `model` is `"opus"`,
  and `progress` is `true`

#### Scenario: Explicit false disables a field

- WHEN the token `worker[output=false,reads=false,skill=false]` is parsed
- THEN `output`, `reads`, and `skill` are each the boolean `false`

#### Scenario: skills is an alias for skill

- WHEN a token uses `skills=review+lint`
- THEN the parsed `skill` value is `["review","lint"]`

#### Scenario: A token without a bracket has empty config

- WHEN the token `scout` is parsed
- THEN the name is `scout` and the inline config is empty

### Requirement: Execution Flag Extraction

The grammar SHALL extract trailing `--bg` and `--fork` execution flags from a
raw argument string, returning the cleaned argument string plus the two boolean
flags, regardless of the order or repetition of the flags.

#### Scenario: Both flags trailing

- WHEN the argument string is `scout "look around" --bg --fork`
- THEN the cleaned arguments are `scout "look around"`
- AND `bg` is `true` and `fork` is `true`

#### Scenario: No flags present

- WHEN the argument string contains neither `--bg` nor `--fork`
- THEN the arguments are returned unchanged and both flags are `false`

### Requirement: Multi-Step Chain and Parallel Argument Grammar

The grammar SHALL parse multi-step arguments for the chain and parallel forms:
steps separated by ` -> `, an optional per-step task given as a double- or
single-quoted string immediately after the agent token, and a single shared
task introduced by the ` -- ` delimiter when no arrow segments are present.

#### Scenario: Arrow segments with per-step quoted tasks

- WHEN the arguments are `scout "recon" -> planner 'plan it'`
- THEN two steps are parsed: `scout` with task `recon` and `planner` with task
  `plan it`

#### Scenario: Shared task via the delimiter

- WHEN the arguments are `scout reviewer -- audit the diff`
- THEN the parsed steps are `scout` and `reviewer`
- AND the shared task is `audit the diff`

### Requirement: Grammar-Level Validation Errors Returned As Data

Validation that depends only on the parsed argument string — empty input, a
chain whose first step has no task, and a parallel run with no task on any step —
SHALL be reported by the grammar as a typed error value rather than by invoking
the UI. The command handler is responsible for presenting the error.

#### Scenario: Empty input yields a usage error

- WHEN the argument string is empty
- THEN the grammar returns an error whose message is the usage string for the
  command

#### Scenario: Chain first step missing a task

- WHEN a chain is parsed and the first step has no task and no shared task
  applies
- THEN the grammar returns a typed `chain-first-task` error

#### Scenario: Parallel with no task anywhere

- WHEN a parallel run is parsed and no step has a task and there is no shared
  task
- THEN the grammar returns a typed `parallel-task` error

### Requirement: Registry and UI Concerns Remain in Command Handlers

Agent-existence validation (via agent discovery), the session-cwd
initialization guard, and all UI notifications SHALL remain in the slash-command
handlers, which consume the grammar module's typed result. The grammar module
MUST NOT depend on agent discovery or the UI.

#### Scenario: Unknown agent reported by the handler

- WHEN a parsed step names an agent that does not exist in the discovered agent
  set
- THEN the command handler notifies the user that the agent is unknown
- AND this check is performed by the handler, not by the grammar module

#### Scenario: Grammar error surfaced by the handler

- WHEN the grammar returns a typed error for a command's arguments
- THEN the handler maps that error's message to a UI notification and aborts the
  command

