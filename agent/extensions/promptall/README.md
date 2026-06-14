# promptall

First-party [pi](https://github.com/earendil-works/pi-coding-agent) extension for searching and reusing old prompts.

`promptall` binds **Ctrl+Alt+R** in interactive pi. The picker searches user prompts from **all saved pi sessions by default**, newest first, and inserts the selected prompt back into the editor without submitting it.

## Usage

```text
Ctrl+Alt+R   # open prompt history search
/promptall   # open the same picker from a slash command
```

Type in the picker to filter results, use arrow keys to move, press Enter to insert, or Escape to cancel. Inserted text stays editable in the prompt box until you submit it yourself.

## Search scope

Promptall reads local pi session JSONL files across saved sessions and includes the current session branch as well. It only indexes text from user prompts; assistant messages, tool results, custom entries, image-only prompts, and malformed session lines are ignored.

Duplicates are collapsed by normalized prompt text, keeping the newest occurrence.

## Install

From this monorepo checkout:

```bash
pi install /Users/cohnesor/.pi/agent/extensions/promptall
```

Or for a one-off local test:

```bash
pi -e ./promptall/index.ts
```

If published to npm later:

```bash
pi install npm:promptall
```

## Local development

```bash
cd promptall
npm install
npm run typecheck
npm test
npm pack --dry-run
```

## Repo structure

```text
promptall/
├── index.ts             # Pi extension entrypoint and TUI picker
├── prompt-history.ts    # Prompt extraction, normalization, ordering, filtering
├── tests/               # Unit and runtime-style tests
├── package.json         # Package metadata and pi manifest
└── tsconfig.json        # TypeScript configuration
```

## License

MIT
