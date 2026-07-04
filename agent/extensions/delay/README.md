# delay

Pi extension that registers `/delay` to send a one-shot message after a delay.

## Usage

```text
/delay [delay] [message]
```

Examples:

```text
/delay check the latest test output
/delay 5m summarize current progress
/delay 1h review whether the deployment has finished
```

- Time units: `s`, `m`, `h`, `d`
- Seconds are rounded up to a minimum of 1 minute
- If no delay is provided, the message sends after 10 minutes
- `/delay` or `/delay --status` shows pending delays
- `/delay --clear` cancels all pending delays

Delayed messages are sent as follow-ups, so they wait for any active agent run to finish instead of steering it.

## Install

From this workspace:

```bash
pi install /Users/cohnesor/.pi/agent/extensions/delay
```

Or run a one-off session:

```bash
pi -e /Users/cohnesor/.pi/agent/extensions/delay
```

## Development

```bash
npm install
npm run check
```
