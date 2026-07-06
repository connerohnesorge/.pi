# Dynamic Workflows Specification

## Requirements

### Requirement: Dynamic Workflow Tool

The extension SHALL provide a `workflow` tool that executes a deterministic JavaScript orchestration script using isolated subagent sessions.

#### Scenario: Script launches agents

- WHEN the parent model calls `workflow` with a script whose first statement exports literal `meta`
- THEN the runtime validates the script, exposes workflow globals including `agent`, `parallel`, `pipeline`, `phase`, `workflow`, `verify`, `judgePanel`, `loopUntilDry`, `completenessCheck`, `retry`, `gate`, `checkpoint`, `args`, `cwd`, and `budget`, and returns the workflow result

#### Scenario: Invalid script is rejected

- WHEN the script omits literal `meta`, uses disallowed nondeterministic APIs, or never calls `agent()`
- THEN the tool fails with a clear validation error instead of starting child sessions

### Requirement: Isolated Agent Execution

The workflow runtime SHALL run each `agent()` call in an isolated Pi SDK session with real model/tool routing and usage accounting.

#### Scenario: Agent model routing

- WHEN an `agent()` call specifies `model`, `tier`, `phase`, or `agentType`
- THEN the child session uses the resolved model/tool/prompt configuration according to documented precedence and records the resolved model in progress state

#### Scenario: Default model tiers

- WHEN no saved model-tier configuration exists
- THEN the `small`, `medium`, and `big` tiers default to `openai-codex/gpt-5.5:low`, `openai-codex/gpt-5.5:medium`, and `openai-codex/gpt-5.5:high` respectively

#### Scenario: Structured output

- WHEN an `agent()` call supplies a JSON Schema
- THEN the child must return a validated value or surface a schema noncompliance error with retry/repair behavior

### Requirement: Background Runs and Resume

The extension SHALL support background workflow runs with persisted state, result delivery, and journaled resume.

#### Scenario: Background default

- WHEN the `workflow` tool is called without `background: false`
- THEN it returns a run id immediately, keeps running outside the current turn, shows live progress, and delivers the final result back into the parent conversation

#### Scenario: Resume uses journal

- WHEN an interrupted run is resumed
- THEN completed unchanged agent calls replay from the persisted journal and only changed or incomplete calls run live

### Requirement: Bordered Workflow TUI

The extension SHALL render workflow progress and navigation through prominent bordered TUI surfaces.

#### Scenario: Live panel

- WHEN one or more workflow runs are active
- THEN a high-contrast bordered panel below the editor shows active runs, phases, agents, status, tokens, cost, and hints without stealing focus

#### Scenario: Navigator overlay

- WHEN the user opens `/workflows`
- THEN a bordered overlay lets the user inspect runs, phases, agents, saved workflows, and details, and supports keyboard actions for pause, resume, stop, restart, save, delete, and close

### Requirement: Workflow Commands and Saved Workflows

The extension SHALL provide commands matching the upstream dynamic workflow extension's user-facing workflows.

#### Scenario: Command control

- WHEN the user invokes `/workflows`, `/workflows status`, `/workflows run`, `/workflows pause`, `/workflows resume`, `/workflows stop`, `/workflows rm`, `/workflows save`, `/workflows-trigger`, `/workflows-progress`, `/workflows-models`, `/effort`, or `/ultracode`
- THEN the extension performs the matching workflow management or configuration action and reports success or failure clearly

#### Scenario: Builtin workflows

- WHEN the user invokes `/deep-research`, `/adversarial-review`, `/multi-perspective`, or `/codebase-audit`
- THEN the extension generates and starts an appropriate dynamic workflow with web/local research, adversarial review, or parallel audit behavior

