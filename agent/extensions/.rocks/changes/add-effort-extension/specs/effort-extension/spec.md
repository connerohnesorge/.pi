## ADDED Requirements

### Requirement: Effort Package Discovery

The system SHALL provide a first-party `effort` pi package that is discoverable by pi as an extension package from this monorepo.

#### Scenario: Package manifest exposes extension

- WHEN pi loads the `effort` package through a local path or npm install
- THEN the package manifest exposes the extension entrypoint through the `pi.extensions` field
- AND the extension imports pi SDK APIs from `@earendil-works/pi-*` packages

#### Scenario: Package metadata is first-party

- WHEN the package metadata is inspected
- THEN the npm/package name and persistent settings namespace are `effort`
- AND repository metadata points at this extensions monorepo rather than the upstream `pi-effort` repository

### Requirement: Thinking Effort Control

The system SHALL let users control the active pi thinking effort through a minimal `/effort` command, CLI flag, and keyboard shortcut.

#### Scenario: Explicit effort level

- WHEN the user invokes `/effort high` on a model that supports `high`
- THEN the extension sets pi's thinking level to `high`
- AND notifies the user of the resulting level

#### Scenario: Semantic aliases adapt per model

- WHEN the user invokes `/effort min` or starts pi with `--effort min` on a reasoning model
- THEN the extension resolves the request to the model's lowest reasoning level
- WHEN the user invokes `/effort max` on an xhigh-capable reasoning model
- THEN the extension resolves the request to `xhigh`
- WHEN the user invokes `/effort max` on a reasoning model without `xhigh`
- THEN the extension resolves the request to `high`

#### Scenario: Unsupported thinking is rejected cleanly

- WHEN the active model does not support the requested effort level
- THEN the extension leaves the current thinking level unchanged
- AND notifies the user with the levels available for that model

#### Scenario: Shortcut cycles available user levels

- WHEN the user presses Ctrl+Shift+E on a reasoning model
- THEN the extension advances to the next user-facing thinking level for that model and wraps at the end
- WHEN the active model has no user-facing thinking levels
- THEN the extension notifies that thinking is unavailable

### Requirement: Fast Mode Control

The system SHALL provide `/fast` as a small persistent latency/service-tier control for GPT-5/OpenAI-Codex requests.

#### Scenario: Fast mode command persists setting

- WHEN the user invokes `/fast on`
- THEN the extension writes `{ "effort": { "fastMode": true } }` into pi's agent settings while preserving unrelated settings
- WHEN the user invokes `/fast off`
- THEN the extension persists `fastMode: false`
- WHEN the user invokes bare `/fast`
- THEN the extension toggles the current persisted fast-mode value

#### Scenario: Provider request priority injection

- WHEN fast mode is enabled and a provider request payload has a GPT-5/OpenAI-Codex model id without an explicit `service_tier`
- THEN the extension returns a replacement payload with `service_tier: "priority"`

#### Scenario: Explicit service tier is preserved

- WHEN fast mode is enabled and a provider request payload already includes `service_tier`
- THEN the extension does not replace the payload

### Requirement: Compact Runtime Status

The system SHALL keep compact runtime status indicators synchronized with thinking effort and fast-mode applicability.

#### Scenario: Status keys reflect current state

- WHEN the session starts or the active model changes
- THEN the extension publishes a thinking status key with `think:<level>`
- AND it publishes a fast-mode status key only when fast mode is enabled and applicable to the current model

#### Scenario: Active run effort is not misrepresented

- WHEN the thinking level changes while an agent run is already active
- THEN the extension continues displaying the effort level that applies to the active run until the run ends
- AND displays the new current thinking level after the run ends

### Requirement: Documentation and Verification

The system SHALL document and verify the `effort` package behavior.

#### Scenario: User documentation

- WHEN a user reads `effort/README.md`
- THEN they can see the command surface, fast-mode behavior, status keys, shortcut, CLI flag, install/dev commands, and verification commands

#### Scenario: Test coverage

- WHEN maintainers run the package tests and typecheck
- THEN parsing, aliases, model capability resolution, settings persistence, slash commands, completions, model clamping, CLI flag application, and fast-mode provider hooks are covered
