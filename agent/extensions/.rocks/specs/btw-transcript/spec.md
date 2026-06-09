# Btw Transcript Specification

## Requirements

### Requirement: Event-sourced transcript reduction

The reducer SHALL fold an ordered stream of agent session events into a transcript of typed entries, assigning each entry a stable monotonically increasing id and grouping entries by turn.

#### Scenario: Turn opens on turn start

- WHEN a `turn_start` event is reduced and no turn is currently open
- THEN a `turn-boundary` entry with phase `start` is appended and the turn becomes the current turn.

#### Scenario: Turn finalizes streaming on turn end

- WHEN a `turn_end` event is reduced for the current turn
- THEN a single `turn-boundary` entry with phase `end` is appended (and not duplicated if already present)
- AND every `thinking`, `assistant-text`, and `tool-result` entry in that turn has its `streaming` flag set to `false`.

### Requirement: Streaming upsert of assistant output

The reducer SHALL upsert assistant thinking and text in place while streaming and mark them final when the turn ends, rather than appending a new entry per update.

#### Scenario: Successive updates replace prior text

- WHEN multiple assistant `message_update` events arrive within one turn
- THEN the latest `thinking` and `assistant-text` entries for that turn have their text replaced in place
- AND no duplicate `thinking` or `assistant-text` entry is created for the turn.

### Requirement: Tool call and result correlation

The reducer SHALL produce a `tool-call` entry per tool execution and correlate it to exactly one `tool-result` entry by tool call id, upserting the result from partial to final.

#### Scenario: Partial then final result update one entry

- WHEN a `tool_execution_update` and then a `tool_execution_end` are reduced for the same `toolCallId`
- THEN one `tool-result` entry is updated in place
- AND its `isError` and `streaming` flags reflect the final event (`streaming` false after end).

#### Scenario: Result without a recorded start is still correlated

- WHEN a tool result event is reduced for a `toolCallId` that has no recorded `tool-call` entry
- THEN a `tool-call` entry is ensured first so the result remains correlated to a call.

### Requirement: Tool result summarization and truncation

The reducer SHALL summarize a tool result value to display text and truncate it beyond a fixed maximum length, flagging that truncation occurred.

#### Scenario: Oversized result is clipped

- WHEN a reduced tool result's summarized text exceeds the maximum length
- THEN the stored content is clipped with a trailing ellipsis
- AND the entry's `truncated` flag is `true`.

### Requirement: User message recorded once per turn

The reducer SHALL record a user message a single time per turn and update it in place if the same turn's user message changes.

#### Scenario: message_start and message_end yield one entry

- WHEN a user `message_start` and later `message_end` are reduced for the same turn
- THEN the turn contains exactly one `user-message` entry carrying the latest text.

### Requirement: Persisted turn replay

The reducer SHALL reconstruct a completed exchange from persisted side-thread details (question, optional thinking, answer) as a single finalized turn.

#### Scenario: Replaying a persisted detail

- WHEN a persisted BTW detail is replayed into an empty transcript state
- THEN the transcript contains one finalized turn with the user question, the optional thinking, and the assistant answer
- AND none of those entries are marked `streaming`.

### Requirement: Failure and cancellation handling

The reducer SHALL record a failure as a finalized assistant entry on the active or last turn, and SHALL remove all of a turn's entries and tool-call records when that turn is cancelled.

#### Scenario: Side-session failure

- WHEN a failure message is reduced
- THEN a non-streaming `assistant-text` entry carrying the error marker is appended to the active or last turn
- AND that turn is finalized.

#### Scenario: Cancelling the latest turn

- WHEN the latest turn is removed
- THEN all entries for that turn are deleted from the transcript
- AND any tool-call records belonging to that turn are discarded.

### Requirement: Transcript status queries

The reducer SHALL expose whether any transcript entry is still streaming and how many assistant exchanges have completed.

#### Scenario: Streaming detection

- WHEN at least one `thinking`, `assistant-text`, or `tool-result` entry has `streaming` set to `true`
- THEN the streaming-status query returns `true`.

#### Scenario: Completed exchange count

- WHEN the transcript contains N finalized (`streaming` false) `assistant-text` entries
- THEN the completed-exchange-count query returns N.

