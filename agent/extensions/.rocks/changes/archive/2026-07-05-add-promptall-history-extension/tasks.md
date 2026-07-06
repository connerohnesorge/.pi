## 1. Package scaffold

- [x] 1.1 Create `promptall/package.json`, `tsconfig.json`, README, and pi package metadata using this monorepo's `@earendil-works` conventions.
- [x] 1.2 Add pure helpers for session JSONL prompt extraction, text normalization, deduplication, recency ordering, and search matching.

## 2. Extension behavior

- [x] 2.1 Register Ctrl+R to open a searchable TUI picker in interactive mode.
- [x] 2.2 Load user prompts from all saved pi sessions by default, including the current session, newest first.
- [x] 2.3 Insert the selected prompt into the editor with `ctx.ui.setEditorText()` without auto-submitting.
- [x] 2.4 Provide a `/promptall` command that opens the same picker for discoverability and non-shortcut invocation.

## 3. Verification and docs

- [x] 3.1 Add tests for prompt extraction from session entries/JSONL, text normalization, deduplication, recency ordering, and filtering.
- [x] 3.2 Add runtime-style tests around shortcut/command registration and selected prompt insertion using mocked pi contexts.
- [x] 3.3 Run typecheck/tests for the `promptall` package and document install, usage, shortcut, command, and verification steps.
