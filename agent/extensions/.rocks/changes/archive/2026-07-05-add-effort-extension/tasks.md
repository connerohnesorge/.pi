## 1. Package scaffold

- [ ] 1.1 Create `effort/package.json`, `tsconfig.json`, README, and package entrypoint manifest matching this monorepo's `@earendil-works` pi package conventions.
- [ ] 1.2 Add pure effort/fast parsing, model-capability, cycling, and settings-persistence helpers under `effort/`.

## 2. Extension behavior

- [ ] 2.1 Register `/effort`, argument completion, `--effort`, and Ctrl+Shift+E cycling using pi's thinking-level APIs.
- [ ] 2.2 Register `/fast`, persist fast mode under the `effort` settings namespace, and inject `service_tier: "priority"` for GPT-5/OpenAI-Codex requests only when no explicit tier exists.
- [ ] 2.3 Keep footer/status and working-message state synchronized across session start, model selection, agent start/turn start, and agent end.

## 3. Verification and docs

- [ ] 3.1 Add unit tests for parsing, aliases, model capability resolution, cycling, and settings persistence.
- [ ] 3.2 Add runtime-style extension tests for commands, flag application, model clamping, completions, and provider-request fast-mode injection.
- [ ] 3.3 Run typecheck/tests for the `effort` package and update README with commands, install/dev instructions, and verification steps.
