## Implementation Details

- Keep the feature inside `goalie`; do not import from the independent `finally` package. `/finally` triggers on `agent_end`, while `/finally-goalie` triggers on successful goal completion.
- Add a small pure helper module, for example `goal-finally.ts`, with:
  - `parseGoalFinallyCommand(args)` for `enqueue`, `status`, and `clear`.
  - snapshot/reconstruction helpers for a `pi-goal-finally` custom session entry.
  - queue operations keyed by `goalId`, replacing any prior item for that goal.
- Store snapshots shaped like:

```ts
interface GoalFinallyItem {
  id: string;
  goalId: string;
  text: string;
  queuedAt: number;
}

interface GoalFinallySnapshot {
  version: 1;
  items: GoalFinallyItem[];
  updatedAt: number;
}
```

- Reconstruct from `ctx.sessionManager.getBranch()` on `session_start` and `session_tree`, matching the existing branch-aware state pattern.
- Register `/finally-goalie` near the other goalie commands. Enqueue requires a focused goal with `status` `active` or `paused`; the raw text is normalized for CRLF/trim only.
- In the existing `turn_end` hook, capture the return value from `completionRuntime.archiveCompletedGoalAtTurnEnd(ctx)`. If it archived a goal, remove that goal's pending final command before sending it with `pi.sendUserMessage(text, { deliverAs: "followUp" })`.
- Clear matching pending entries without sending when the user clears or aborts a goal. Pause and audit rejection keep the pending command because the goal may still complete later.

## Goals / Non-Goals

- Goals:
  - Run exactly one raw pi input after successful goal completion.
  - Allow that input to be a slash command, another `/goalie` request, or plain prompt.
  - Keep state reload-safe and branch-aware.
- Non-Goals:
  - No shell command runner.
  - No changes to the independent `/finally` package.
  - No cross-session watcher that fires when another pi session completes the same goal.

## Risks / Trade-offs

- Sending from `turn_end` means the current agent run is not fully idle yet; using `deliverAs: "followUp"` is required and matches the pi extension API.
- Replacing one pending command per goal avoids multi-command races where several slash commands compete immediately after completion. Users can put multiple instructions in one prompt if needed.
