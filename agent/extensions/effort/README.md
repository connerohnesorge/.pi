# effort

First-party extension for [pi](https://github.com/earendil-works/pi-coding-agent) that keeps the command surface tiny while making thinking effort and GPT-5 fast mode easy to control.

## Commands

Exactly two slash commands are exposed:

```text
/effort {min|minimal|low|medium|high|xhigh|max}
/fast [on|off]
```

No `/effort show`, `/effort default`, `/effort options`, `/effort fast`, or `/fast status`. Bare `/fast` toggles the current fast-mode setting.

## Effort

`/effort` accepts the current model's supported reasoning levels plus two adaptive aliases:

| Model type | `min` | `max` | Explicit levels |
|---|---|---|---|
| Non-reasoning | — | — | *(thinking unavailable)* |
| Reasoning | `minimal` | `high` | `minimal`, `low`, `medium`, `high` |
| xhigh-capable reasoning | `minimal` | `xhigh` | `minimal`, `low`, `medium`, `high`, `xhigh` |

Examples:

```text
/effort min
/effort medium
/effort max
```

## Fast mode

Fast mode is the latency/service-tier knob. When enabled, `effort` adds `service_tier: "priority"` to GPT-5 / OpenAI-Codex provider requests that do not already specify a tier.

```text
/fast      # toggle
/fast on   # force on
/fast off  # force off
```

Fast mode persists in `~/.pi/agent/settings.json` under:

```json
{
  "effort": {
    "fastMode": true
  }
}
```

## Footer status

For compact powerline footers, the extension publishes these status keys:

- `effort-thinking` — `think:<level>`
- `effort-fast` — `fast` only when fast mode is enabled and applies to the current model

## Keyboard shortcut

`Ctrl+Shift+E` cycles through the current model's reasoning levels.

## CLI flag

```bash
pi --effort max
pi --effort min
pi --effort high
```

The flag uses the same values as `/effort`.

## Install

From this monorepo checkout:

```bash
pi install /Users/cohnesor/.pi/agent/extensions/effort
```

Or for a one-off local test:

```bash
pi -e ./effort/index.ts
```

If published to npm later:

```bash
pi install npm:effort
```

Verify what pi is loading:

```bash
pi list
npm list -g --depth=0 effort
```

## Local development

```bash
cd effort
npm install
npm run typecheck
npm test
npm pack --dry-run
```

## Repo structure

```text
effort/
├── index.ts             # Pi extension entrypoint
├── effort.ts            # Parsing, settings, fast-mode, and model-capability helpers
├── tests/               # Unit and runtime-style tests
├── package.json         # Package metadata and pi manifest
└── tsconfig.json        # TypeScript configuration
```

## License

MIT
