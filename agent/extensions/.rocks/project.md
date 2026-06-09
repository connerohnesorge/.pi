# extensions Context

## Purpose

A monorepo of four independent **extensions for `pi`** (the `@earendil-works` "pi" coding
agent / harness). Each extension is its own npm package, installed into a pi session via
`pi install npm:<name>`, and adds some combination of tools, slash-commands, skills, hooks,
TUI widgets, and renderers to the parent agent.

The four extensions:

- **ask-user** (`ask_user`) — an interactive tool that gives pi a searchable, split-pane
  terminal selection UI with multi-select and freeform input, plus a headless dialog
  fallback. Entry: `ask-user/index.ts`; viewport/layout math in `single-select-layout.ts`.
- **btw** (`/btw`) — parallel side-conversations: run a side thread (optionally with a
  different model / thinking level) without derailing the main agent turn, then inject or
  summarize the result back into the main session. Entry: `btw/extensions/btw.ts`; guidance
  skill under `btw/skills/btw`.
- **goalie** — a session-scoped **Stop-hook goal-contract manager**: the agent or user
  defines goal conditions that must be satisfied before the agent is allowed to Stop; a live
  progress-auditor widget renders status, an independent auditor sub-agent verifies
  completion, and goals are editable via `$EDITOR`. Entry: `goalie/extensions/goal.ts`
  (plus many `goal-*` modules, `prompts/`, `storage/`, `widgets/`).
- **subagents** (`pi-subagents`) — delegate work to focused **child pi sessions**:
  foreground (streamed) and background (detached) runs, sequential chains, parallel fan-out,
  git-worktree isolation, TUI clarification, and a parent↔child intercom for messages and
  results. Builtin agents: `scout`, `researcher`, `planner`, `worker`, `reviewer`,
  `context-builder`, `oracle`, `delegate`. Entry: `subagents/src/extension/index.ts`;
  execution engine under `subagents/src/runs/`.

## Tech Stack

- **TypeScript**, ESM (`"type": "module"`), strict, ES2022/ESNext target, run directly with
  **tsx** (no build step in dev — `noEmit`, `.ts` extension imports allowed).
- **Vitest** for tests. `subagents` splits `test:unit` / `test:integration` / `test:all`;
  `goalie` and `btw` use a single `test` script; `ask-user` has a `check` script.
- **pi SDKs**: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
  `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`. `goalie` uses **TypeBox** for
  tool schemas.
- **Nix flake** dev shell (`flake.nix` at repo root) providing the toolchain plus optional
  linters (ESLint / oxlint / Biome) and formatters (Prettier / Biome).
- Shipped as npm packages; consumed by the `pi` runtime, not run standalone.

## Project Conventions

### Code Style

- Match the surrounding file. Tab indentation; ESM imports that include the `.ts` extension;
  `import type` for type-only imports. Strict TypeScript throughout.
- Prefer **deep modules**: a small interface over substantial behavior. Avoid shallow
  pass-throughs and inline re-declarations of a shared type.

### Architecture Patterns

- Each extension registers its tools / slash-commands / hooks / renderers / widgets against
  the pi extension API from a **single entry point** (e.g. `registerSubagentExtension(pi)`).
- Effectful modules expose **dependency-injected seams** (e.g. `{ kill, now, fs, timers }`)
  so they can be unit-tested without real processes, clocks, or disk.
- Background/detached work communicates through the **filesystem** (`status.json`,
  `events.jsonl`, result files) observed by watchers/reconcilers, rather than shared memory.
- Pure decision logic should be separable from terminal IO and lifecycle so it is testable
  on plain data (the standing direction of the in-flight refactors below).

### Testing Strategy

- Vitest. Unit tests cover pure logic directly; integration tests drive the extension or
  spawn a mock `pi` binary end-to-end.
- For refactors, the **existing suites are the behavior-preservation net** — changes here are
  expected to be behavior-preserving unless a spec delta says otherwise.

### Git Workflow

- Default branch is `main`. Branch before committing; commit/push only when asked.
- Substantive changes flow through the **rocks change workflow** (see Domain Context):
  proposal → `cnb rocks accept` → implement via `/rocks:next` → `cnb rocks archive`.

## Domain Context

"pi" is the **parent coding-agent session**. Extensions extend it with:

- **tools** — model-callable functions (e.g. `ask_user`, `subagent`, `update_goal`).
- **slash-commands** — user-invoked (e.g. `/btw`, `/run`, `/chain`, `/parallel`).
- **skills** — `SKILL.md` guidance documents the agent loads on demand.
- **hooks** — lifecycle callbacks (`before_agent_start`, `turn_end`, the **Stop** gate).
- **widgets / renderers** — live TUI surfaces and custom message rendering.

Key domain terms: a **subagent** is a focused child pi session (foreground or background);
a **goal** is a Stop-gate completion contract goalie enforces; the **intercom** is the
parent↔child message/result channel in `subagents`.

This workspace uses **rocks** (`cnb rocks` + the `/proposal`, `/rocks:next`, `/archive`
skills) to manage changes. Change proposals live under `.rocks/changes/<id>/` as
`proposal.md` (why/what/impact), `design.md` (interfaces, ADRs), `tasks.md` (ordered
checklist), and `specs/<capability>/spec.md` (ADDED/MODIFIED/REMOVED requirements with
WHEN/THEN scenarios). Capability specs merge into `.rocks/specs/` on archive.

## Important Constraints

- **In-flight architecture refactors.** `.rocks/changes/` currently holds **11 validated,
  behavior-preserving deepening proposals** from a two-wave adversarial architecture review
  (candidates C1–C10, C12). Each encodes a consensus-corrected scope as an explicit
  Non-Goal/ADR — respect those boundaries when implementing.
- **Implementation-order conflicts** (shared source files): `subagent-executor.ts` is edited
  by `refactor-deepen-foreground-control`, `extract-intercom-bridge-gate`, and
  `extract-override-input-normalizer`; `render.ts` by `refactor-unify-nested-run-walker` and
  `refactor-extract-render-progress-model`; `slash-commands.ts` by `extract-slash-grammar`
  and `extract-override-input-normalizer`. Serialize within each cluster; the other five
  changes touch disjoint files and can proceed in parallel.

## External Dependencies

- The **`pi` runtime/CLI** itself (the host the extensions plug into).
- The **`@earendil-works/pi-*`** SDK packages.
- **Nix** (dev shell) and **npm** (distribution).
