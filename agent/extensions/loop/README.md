# loop

Pi extension that registers `/loop` to repeat a task on a schedule.

## Usage

```text
/loop [interval] [task]
```

Examples:

```text
/loop check the latest test output
/loop 5m summarize current progress
/loop 1h review whether the deployment has finished
```

- Time units: `s`, `m`, `h`, `d`
- Seconds are rounded up to a minimum of 1 minute
- If no interval is provided, the loop runs every 10 minutes
- `/loop` or `/loop --status` shows active loops
- `/loop --clear` stops all active loops
