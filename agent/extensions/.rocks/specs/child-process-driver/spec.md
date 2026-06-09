# Child Process Driver Specification

## Requirements

### Requirement: Shared Child-Process Driver

Both foreground and background subagent execution SHALL drive the child `pi` process through
a single shared driver that owns spawning, stdout JSON-stream parsing, message and usage
accumulation, the terminal-stop drain handshake, and signal escalation. Neither execution
path SHALL re-implement that core.

#### Scenario: Foreground execution drives the child through the shared driver

- WHEN a synchronous (foreground) subagent run starts
- THEN it spawns and parses the child via the shared driver
- AND it does not contain its own spawn/parse/drain implementation

#### Scenario: Background execution drives the child through the shared driver

- WHEN a detached (background) subagent run starts
- THEN it spawns and parses the child via the same shared driver
- AND the terminal-stop drain machinery exists in only the shared driver module

### Requirement: Parsed Event Projection Seam

The shared driver SHALL expose the parsed child event stream to a consumer projection and
return a normalized terminal result, without owning how progress is presented. Each caller
SHALL project that stream independently.

#### Scenario: Foreground projects live progress snapshots

- WHEN the shared driver emits parsed events during a foreground run
- THEN the foreground projection mirrors them into in-process progress and emits live update
  snapshots to the caller
- AND the shared driver itself emits no presentation output

#### Scenario: Background projects a file-backed status stream

- WHEN the shared driver emits parsed events during a background run
- THEN the background projection writes the raw output stream and the JSONL event sideband
  and updates the file-backed status payload
- AND the shared driver itself writes no status files

### Requirement: Terminal-Stop Drain Handshake

The shared driver SHALL own a single terminal-stop drain: when the child emits a final
assistant stop with no pending tool call, it SHALL allow a grace period, then escalate
SIGTERM and finally SIGKILL if the child has not exited, and SHALL report a clean
forced-drain-after-final-success as exit code 0.

#### Scenario: Clean terminal stop that exits within the grace period

- WHEN the child emits a terminal assistant stop and then exits before the grace period ends
- THEN the run reports the child's own exit code
- AND no forced termination signal is recorded

#### Scenario: Terminal stop where the child does not exit

- WHEN the child emits a terminal assistant stop but does not exit within the grace period
- THEN the driver escalates SIGTERM and then SIGKILL
- AND a clean forced-drain-after-final-success is reported as exit code 0

### Requirement: Consistent Usage Accounting

The shared driver SHALL accumulate token usage once, accepting the superset of token field
names, so that the foreground and background paths report identical usage totals for the same
child output.

#### Scenario: Usage is accounted identically for both paths

- WHEN an assistant message reports token usage using either the canonical or the alternate
  token field names
- THEN the accumulated input and output token totals are identical regardless of which
  execution path drove the child

