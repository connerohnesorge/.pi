## ADDED Requirements

### Requirement: Promptall Package Discovery

The system SHALL provide a first-party `promptall` pi package that is discoverable by pi as an extension package from this monorepo.

#### Scenario: Package manifest exposes extension

- WHEN pi loads the `promptall` package through a local path or npm install
- THEN the package manifest exposes the extension entrypoint through the `pi.extensions` field
- AND the extension imports pi SDK APIs from `@earendil-works/pi-*` packages

#### Scenario: Package metadata is first-party

- WHEN the package metadata is inspected
- THEN the npm/package name is `promptall`
- AND repository metadata points at this extensions monorepo

### Requirement: All-Session Prompt History Search

The system SHALL search user prompts across all saved pi sessions by default.

#### Scenario: Saved prompts are listed newest first

- WHEN the user opens promptall history
- THEN promptall reads saved pi session files across projects
- AND lists user prompts ordered by newest occurrence first

#### Scenario: Current session prompts are included

- WHEN the active session has user prompts on the current branch
- THEN promptall includes those prompts in the search results even if the session file has not yet been flushed or listed

#### Scenario: Non-prompt entries are ignored

- WHEN session files contain assistant messages, tool results, custom entries, image-only user messages, or malformed lines
- THEN promptall excludes them from prompt search without failing the picker

### Requirement: Searchable Ctrl+R Picker

The system SHALL let users press Ctrl+R in interactive pi to search historical prompts.

#### Scenario: Shortcut opens searchable picker

- WHEN the user presses Ctrl+R in a TUI session
- THEN promptall opens a searchable prompt-history picker
- AND the user can filter prompts by typing search text

#### Scenario: Slash command opens same picker

- WHEN the user invokes `/promptall`
- THEN promptall opens the same prompt-history picker as Ctrl+R

#### Scenario: Non-interactive mode is rejected cleanly

- WHEN promptall is invoked without a TUI
- THEN the extension notifies that promptall requires interactive mode
- AND does not attempt to render a custom picker

### Requirement: Prompt Insertion

The system SHALL insert a selected historical prompt into the current pi prompt editor without submitting it.

#### Scenario: Selected prompt populates editor

- WHEN the user selects a prompt from the picker
- THEN promptall writes that prompt into the editor via pi's editor-text API
- AND the prompt remains editable before submission

#### Scenario: Cancel leaves editor unchanged

- WHEN the user cancels the picker
- THEN promptall leaves the current editor text unchanged
- AND no prompt is submitted

### Requirement: Documentation and Verification

The system SHALL document and verify the `promptall` package behavior.

#### Scenario: User documentation

- WHEN a user reads `promptall/README.md`
- THEN they can see the package purpose, install/dev instructions, Ctrl+R shortcut, `/promptall` command, all-session search scope, and verification commands

#### Scenario: Test coverage

- WHEN maintainers run the package tests and typecheck
- THEN prompt extraction, normalization, deduplication, recency ordering, filtering, command/shortcut registration, and selected prompt insertion are covered
