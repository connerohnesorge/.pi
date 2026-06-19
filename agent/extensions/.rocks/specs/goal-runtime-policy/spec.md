# Goal Runtime Policy Specification

## Requirements

### Requirement: Shared Auditor Progress Contract

The goalie extension SHALL use one shared auditor progress interface between the auditor runner and widget renderer, with durations rendered from millisecond timestamps using explicit conversion to seconds.

#### Scenario: Current tool duration is rendered in seconds

- WHEN auditor progress reports a current tool that started 5 seconds ago
- THEN the widget renders a 5-second duration, not a 5000-second duration

### Requirement: Pure Goal Tool Policy

The goalie extension SHALL compute active goal tools and per-turn tool-call decisions through pure policy functions before the pi adapter applies them.

#### Scenario: Active goal tools are computed without the pi adapter

- WHEN the focused goal is active and no drafting flow is armed
- THEN the policy includes lifecycle tools and work tools while keeping direct `create_goal` hidden

#### Scenario: Post-stop tool calls are blocked consistently

- WHEN a lifecycle tool has already stopped the goal in the current turn
- THEN the policy blocks subsequent non-allowed tools and permits `get_goal`

### Requirement: Objective and Tweak Runtime Operations

The goalie extension SHALL apply objective updates and prompt-driven goal tweaks through shared runtime operations rather than duplicating active-file, state-entry, ledger, tool-sync, UI, and turn-stop effects inside tool handlers.

#### Scenario: Quick objective update stays non-terminating

- WHEN `update_goal` receives only `updatedObjective`
- THEN the runtime operation writes the revised active goal, appends state and tweak history, updates UI, and returns without terminating the turn

#### Scenario: Prompt-driven tweak is reachable and terminal

- WHEN the user starts `/goalie-tweak` and the agent calls `apply_goal_tweak`
- THEN the runtime operation writes the revised active goal, clears the tweak gate, marks the current turn stopped, appends tweak history, and returns `terminate: true`

