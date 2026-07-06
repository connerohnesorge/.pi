## ADDED Requirements

### Requirement: Delay Package Discovery

The system SHALL provide a first-party `delay` pi package that is discoverable by pi as an extension package from this monorepo.

#### Scenario: Package manifest exposes extension

- WHEN pi loads the `delay` package through a local path or npm install
- THEN the package manifest exposes the extension entrypoint through the `pi.extensions` field
- AND the extension imports pi SDK APIs from `@earendil-works/pi-coding-agent`

### Requirement: One-Shot Delayed Messages

The delay extension SHALL register a `/delay [duration] <message>` slash command that schedules a one-shot user message for future delivery. Duration arguments SHALL match `/loop`-style units (`s`, `m`, `h`, `d`), seconds SHALL round up to the one-minute minimum, and missing duration SHALL default to ten minutes.

#### Scenario: Explicit duration schedules message

- WHEN the user invokes `/delay 5m check the deployment`
- THEN the extension schedules `check the deployment` to send once after five minutes
- AND it shows feedback that the delayed message is scheduled

#### Scenario: Default duration schedules message

- WHEN the user invokes `/delay check the deployment`
- THEN the extension schedules `check the deployment` to send once after the default delay

### Requirement: Status and Clear Controls

The delay extension SHALL expose `/delay` or `/delay --status` to show pending delayed messages and `/delay --clear` to cancel all pending delayed messages.

#### Scenario: Status lists pending delays

- GIVEN one or more delayed messages are pending
- WHEN the user invokes `/delay --status`
- THEN the extension shows each pending message with its delay label and remaining time

#### Scenario: Clear cancels pending delays

- GIVEN one or more delayed messages are pending
- WHEN the user invokes `/delay --clear`
- THEN the extension cancels their timers
- AND shows how many delayed messages were cancelled
