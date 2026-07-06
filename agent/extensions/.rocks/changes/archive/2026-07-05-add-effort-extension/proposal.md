# Change: Add effort extension package

## Why

We want a first-party version of `pi-effort` in this extensions monorepo so Conner can control pi thinking effort and GPT-5 fast-mode behavior without depending on a third-party package namespace.

## What Changes

- Add a new `effort` pi package with the same small command surface as the referenced repo: `/effort {min|minimal|low|medium|high|xhigh|max}` and `/fast [on|off]`.
- Port the implementation to this workspace's `@earendil-works/pi-*` SDK packages, metadata, style, and test conventions.
- Persist fast mode under an `effort` settings namespace in `~/.pi/agent/settings.json`.
- Publish compact status keys for thinking effort and fast mode, plus a Ctrl+Shift+E effort-cycle shortcut and `--effort` CLI flag.
- Add unit/runtime tests and README usage/install guidance for the local `effort` package.

## Impact

- Affected specs: `effort-extension` (new)
- Affected code: new `effort/` package directory, package metadata, tests, README
- Compatibility: introduces `/effort` and `/fast` slash commands; no existing package in this workspace currently claims those command names.
