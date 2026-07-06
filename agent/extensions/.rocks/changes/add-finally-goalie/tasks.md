## 1. Implementation

- [ ] 1.1 Add a small pure `goal-finally` helper for `/finally-goalie` parsing, branch snapshot reconstruction, keyed replacement, clearing, and dequeue-on-completion.
- [ ] 1.2 Register `/finally-goalie` in `goalie/extensions/goal.ts` with enqueue, `--status`, and `--clear` behavior, including focused-goal validation and compact notifications/status.
- [ ] 1.3 Wire successful deferred completion archival to dequeue and `pi.sendUserMessage(..., { deliverAs: "followUp" })`, and clear pending commands on goal clear/abort without sending.
- [ ] 1.4 Add unit tests for parsing, persistence reconstruction, replacement/clear semantics, completion dispatch, and non-dispatch paths.
- [ ] 1.5 Run `npm --prefix goalie run typecheck`, `npm --prefix goalie run test`, and focused package validation.
