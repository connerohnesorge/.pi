# finally

`finally` is a tiny pi extension for scheduling a follow-up prompt only after the current agent run fully stops.

```text
/finally make sure all tests pass now that you did the new feature
```

## Usage

- `/finally <message>` queues `<message>` as a future user prompt.
- `/finally --status` shows how many messages are pending.
- `/finally --clear` cancels all pending messages.
- `/finally -- <message>` forces a message that starts with `--`.

Queued messages are session-scoped. They are flushed from pi's `agent_end` lifecycle hook with follow-up delivery, so they do not steer or interrupt the current agent run. If you queue one while pi is idle, it waits until the next agent run finishes before firing.

When multiple messages are queued, `finally` sends one message per full stop in first-in-first-out order.

## Install

From this workspace:

```bash
pi install /Users/cohnesor/.pi/agent/extensions/finally
```

Or run a one-off session:

```bash
pi -e /Users/cohnesor/.pi/agent/extensions/finally
```

## Development

```bash
npm install
npm run check
```
