## ADDED Requirements

### Requirement: Goalie Completion Final Command

The goalie extension SHALL provide a `/finally-goalie <prompt-or-command>` command that attaches one pending raw pi input to the focused active or paused goal and does not run that input immediately. If the input begins with `/`, the leading slash and remaining text MUST be preserved so pi can process it later as a full slash command.

#### Scenario: Queue a slash command for the focused goal

- GIVEN a focused active goal
- WHEN the user invokes `/finally-goalie /goalie-set follow-up objective`
- THEN the extension stores `/goalie-set follow-up objective` as the pending final command for that goal
- AND the command is not sent during the current agent run

#### Scenario: Replace the pending command for the same goal

- GIVEN a focused active goal with a pending final command
- WHEN the user invokes `/finally-goalie write a short summary` for the same goal
- THEN the new text replaces the prior pending final command for that goal
- AND only the replacement remains eligible to run after completion

#### Scenario: No focused runnable goal

- GIVEN there is no focused goal with status `active` or `paused`
- WHEN the user invokes `/finally-goalie run this later`
- THEN the extension notifies that a focused goal is required
- AND no final command is persisted

### Requirement: Successful Completion Dispatch

The goalie extension SHALL dispatch a pending final command exactly once, only after the matching goal is marked complete and the deferred `turn_end` archival succeeds. Dispatch MUST remove the pending command before sending it with `pi.sendUserMessage(text, { deliverAs: "followUp" })`.

#### Scenario: Completion archives and sends the final command

- GIVEN a focused goal has a pending final command
- WHEN `update_goal(status=complete)` is accepted and `turn_end` archives that completed goal
- THEN the extension removes the pending final command for that goal
- AND sends the stored text as a follow-up user message

#### Scenario: Audit rejection does not dispatch

- GIVEN a focused goal has a pending final command
- WHEN the completion auditor rejects an `update_goal(status=complete)` request
- THEN the final command is not sent
- AND the pending final command remains attached to the goal

#### Scenario: Non-completion terminal actions do not dispatch

- GIVEN a focused goal has a pending final command
- WHEN the user clears or aborts that goal
- THEN the final command for that goal is removed without being sent

### Requirement: Branch-Aware Goal Finally Persistence

The goalie extension SHALL persist pending final commands as custom session entries, reconstruct them from the current branch on session start and tree navigation, and expose status and clear controls through `/finally-goalie --status` and `/finally-goalie --clear`.

#### Scenario: Reload restores pending final command

- GIVEN a pending final command was persisted on the current session branch
- WHEN the session reloads
- THEN `/finally-goalie --status` reports the pending command
- AND the command remains eligible for dispatch when the matching goal completes

#### Scenario: Clear removes pending final commands

- GIVEN one or more pending final commands exist on the current branch
- WHEN the user invokes `/finally-goalie --clear`
- THEN the extension clears the pending final command state
- AND no cleared command is sent when its former goal completes
