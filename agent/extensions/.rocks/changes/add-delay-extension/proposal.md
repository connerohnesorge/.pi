# Change: Add delay extension package

## Why

Conner wants a small pi extension that sends a prompt after a delay using the same simple duration syntax as `/loop`, without creating a repeating loop.

## What Changes

- Add a new independent `delay` pi package under `./delay`.
- Register a `/delay [duration] <message>` slash command with `/loop`-style time units (`s`, `m`, `h`, `d`) and a 10 minute default.
- Schedule one-shot delayed user messages with status and clear commands.
- Add compact status/notification feedback, README usage guidance, and unit tests for parsing and formatting.

## Impact

- Affected specs: `delay-extension` (new)
- Affected code: new `delay/` package directory, root workspace metadata, package metadata, extension entrypoint, tests, README
- Compatibility: introduces the `/delay` slash command; no existing package in this workspace currently claims that command name.
