## Implementation Details

Create `promptall/` as a small npm/pi package with `pi.extensions: ["./index.ts"]`, TypeScript tests, and no runtime dependencies beyond pi SDK packages.

The extension will:

- register a Ctrl+R shortcut and `/promptall` command;
- guard interactive picker behavior with `ctx.mode === "tui"`;
- collect saved session files through `SessionManager.listAll()` and parse JSONL defensively;
- collect user-message prompts from each file, plus current in-memory branch entries so unsaved/current prompts are present;
- normalize prompt content by extracting text blocks, trimming, and ignoring empty/image-only prompts;
- sort newest first and deduplicate by normalized text, keeping the newest occurrence;
- present results in a searchable TUI picker using `SelectList` plus a small framed container;
- call `ctx.ui.setEditorText(selected.prompt)` after selection and never auto-submit.

Pure helpers should own extraction/ranking/filtering so behavior can be tested without launching pi.

## Context

Pi sessions are JSONL files with `message` entries containing `role: "user"` messages. The pi SDK exposes `SessionManager.listAll()` for saved sessions and `ctx.sessionManager.getBranch()` for the current branch.

## Goals / Non-Goals

- Goals: fast Ctrl+R prompt reuse, all saved sessions by default, searchable picker, safe insertion into the editor, package-local docs/tests.
- Non-Goals: fuzzy indexing daemon, editing/deleting history, submitting prompts automatically, storing a separate history database, or changing pi's built-in session selector shortcuts.

## Risks / Trade-offs

- Large session histories may make loading slow. Mitigation: parse defensively, cap displayed results to a reasonable default, and keep filtering local.
- Session content may include sensitive data. Mitigation: read only local pi session files and display content only in the user's interactive TUI.
- Ctrl+R may collide with future pi defaults. Mitigation: document that it is an extension shortcut and can be removed by disabling the package.
