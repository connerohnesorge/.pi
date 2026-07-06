# Change: Add goalie completion finalizer command

## Why

Conner wants a `/finally-goalie` command that runs a full pi input only after the focused goalie goal is actually completed, so goal chains can hand off to another `/goalie`, slash command, or plain prompt without firing on every agent stop.

## What Changes

- Add `/finally-goalie <prompt-or-command>` to the goalie extension.
- Attach one pending final command to the focused active or paused goal; a later `/finally-goalie ...` for the same goal replaces the previous command.
- Preserve the final command text as raw user input, including leading slash commands such as `/goalie ...`.
- Persist pending commands as branch-aware custom session entries, with `/finally-goalie --status` and `/finally-goalie --clear` controls.
- After `update_goal(status=complete)` is approved and the deferred `turn_end` archival succeeds, dequeue the matching final command and send it with `pi.sendUserMessage(..., { deliverAs: "followUp" })`.
- Do not fire on pause, abort, clear, audit rejection, or generic `agent_end` stops.

## Impact

- Affected specs: `goal-completion`
- Affected code: `goalie/extensions/goal.ts`, new goalie helper module for command parsing/queue state, goalie tests
- Compatibility: introduces `/finally-goalie`; existing `/finally` remains an independent agent-stop queue.
