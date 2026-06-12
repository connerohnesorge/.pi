# Change: Add promptall prompt-history extension

## Why

Conner wants a first-party `promptall` pi extension that makes prior prompts easy to reuse from the TUI, similar to shell reverse history search.

## What Changes

- Add a new independent `promptall` pi package under `./promptall`.
- Register Ctrl+R to open a searchable prompt-history picker in interactive pi sessions.
- Search user prompts across all saved pi sessions by default, with newest prompts first.
- Insert the selected historical prompt into the current prompt editor without submitting it.
- Add README guidance and tests for prompt extraction, ranking/filtering, and insertion behavior seams.

## Impact

- Affected specs: `promptall-history` (new)
- Affected code: new `promptall/` package directory, package metadata, extension entrypoint, helpers, tests, README
- Compatibility: Ctrl+R is not a default main-editor pi binding, but it is used inside session selectors for rename; `promptall` only binds Ctrl+R at the main extension shortcut layer.
