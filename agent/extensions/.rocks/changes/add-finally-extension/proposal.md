# Change: Add finally extension package

## Why

Conner wants a small pi extension that can schedule a follow-up instruction while an agent is still working, without steering the current run or firing until the agent has fully stopped.

## What Changes

- Add a new independent `finally` pi package under `./finally`.
- Register a `/finally <message>` slash command that queues a user message for delayed delivery.
- Flush queued messages from the `agent_end` lifecycle hook, using pi's follow-up delivery so the message starts only after the current agent run reaches a full stop.
- Keep the queue session-scoped, branch-aware, and reload-resilient via custom session entries.
- Add compact status/notification feedback, README usage guidance, and unit tests for command parsing and queue reconstruction/flush behavior.

## Impact

- Affected specs: `finally-extension` (new)
- Affected code: new `finally/` package directory, package metadata, extension entrypoint, queue helper, tests, README
- Compatibility: introduces the `/finally` slash command; no existing package in this workspace currently claims that command name.
