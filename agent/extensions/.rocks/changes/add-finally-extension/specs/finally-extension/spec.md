## ADDED Requirements

### Requirement: Slash Command Queues Deferred User Messages

The finally extension SHALL register a `/finally` slash command that accepts a non-empty message and stores it as a pending session-scoped user message without triggering an agent turn immediately. If invoked while the agent is idle, the message SHALL remain pending until the next agent run reaches `agent_end` rather than sending immediately.

#### Scenario: Active run queues without steering

- WHEN the user invokes `/finally make sure all tests pass` while an agent run is active
- THEN the extension stores `make sure all tests pass` as a pending message
- AND the current agent run is not steered or interrupted by that message

#### Scenario: Idle invocation waits for a future stop

- WHEN the user invokes `/finally make sure all tests pass` while no agent run is active
- THEN the extension stores the message as pending
- AND it does not send the message until a later agent run reaches `agent_end`

### Requirement: Full-Stop FIFO Delivery

The finally extension SHALL deliver pending messages only from the `agent_end` lifecycle hook. Delivery SHALL dequeue the oldest pending message before sending it via `pi.sendUserMessage(..., { deliverAs: "followUp" })`, so each queued instruction starts after a full agent stop and cannot repeatedly re-trigger itself.

#### Scenario: First queued message fires after stop

- GIVEN one pending finally message
- WHEN the current agent run emits `agent_end`
- THEN the extension removes that message from the queue
- AND sends it as a follow-up user message

#### Scenario: Multiple queued messages remain ordered

- GIVEN multiple pending finally messages
- WHEN consecutive agent runs emit `agent_end`
- THEN the extension sends the messages in first-in-first-out order
- AND sends at most one pending message for each full stop

### Requirement: Branch-Aware Queue Persistence and Visibility

The finally extension SHALL persist queue snapshots as custom session entries, reconstruct the pending queue from the current branch on session start or tree navigation, and show compact feedback when messages are queued, flushed, or cleared.

#### Scenario: Reload restores pending queue

- GIVEN a pending finally message was persisted in the current session branch
- WHEN the session reloads
- THEN the extension reconstructs that message as pending
- AND keeps it eligible for delivery at the next full stop

#### Scenario: Clearing pending messages updates state

- GIVEN one or more pending finally messages
- WHEN the user invokes `/finally --clear`
- THEN the extension clears the queue
- AND persists an empty queue snapshot
