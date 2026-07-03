# pi-subagents

`pi-subagents` now provides a dynamic workflow runtime for Pi: a `workflow` tool, background run manager, saved workflows, model-tier routing, and a prominent bordered TUI for inspecting runs.

It is a local, cleaner implementation of the behavior exposed by `@quintinshaw/pi-dynamic-workflows`, adapted for this extension workspace.

## Install

```bash
pi install npm:pi-subagents
```

Then reload Pi.

## What you get

- `workflow` tool for deterministic JavaScript orchestration scripts.
- `agent()`, `parallel()`, `pipeline()`, `phase()`, `workflow()`, and quality helpers like `verify()` and `judgePanel()`.
- Background runs by default, with completion delivered back into the parent conversation.
- Journaled resume so completed unchanged agent calls are replayed instead of rerun.
- Model tier routing through `/workflows-models`; defaults are `openai-codex/gpt-5.5:low`, `:medium`, and `:high`.
- Saved workflows and commands through `/workflows`.
- Bordered live panel and bordered `/workflows` navigator.
- Built-ins: `/deep-research`, `/adversarial-review`, `/multi-perspective`, `/codebase-audit`, `/effort`, and `/ultracode`.

## Example workflow

```js
export const meta = {
  name: "auth_audit",
  description: "Audit auth checks",
  phases: [{ title: "scan" }, { title: "review" }, { title: "synthesize" }],
};

phase("scan");
const files = await agent("List route files under src/routes.", { label: "route inventory", tier: "small" });

phase("review");
const findings = await parallel(
  files.split("\n").filter(Boolean).map((file) => () =>
    agent(`Review ${file} for missing auth checks.`, { label: file, tier: "medium" }),
  ),
);

phase("synthesize");
return await agent("Deduplicate and rank these findings:\n" + findings.join("\n\n"), {
  label: "final synthesis",
  tier: "big",
});
```

## Commands

```text
/workflows                         open the bordered workflow navigator
/workflows run <prompt>            force a dynamic workflow from a prompt
/workflows status <id>             watch a run and print result when finished
/workflows pause|resume|stop|rm <id>
/workflows save <name>             save the latest run as /<name>
/workflows-trigger off|on|status|set <word>|reset
/workflows-progress compact|detailed|status
/workflows-progress-max <N>
/workflows-models                  map small/medium/big tiers to models
/effort off|high|ultra
/ultracode [off]
/deep-research <question>
/adversarial-review <task>
/multi-perspective "<topic>" [angle ...]
/codebase-audit <scope> "<check>" ...
```

## Storage

Workflow data lives under `~/.pi/workflows`:

- `settings.json`
- `model-tiers.json`
- `projects/<project>/runs/`
- `projects/<project>/saved/`

## Compatibility

This is a hard replacement for the old subagent runtime. The old `subagent`, `subagent_manage`, `subagent_control`, `/run`, `/chain`, and `/parallel` APIs are intentionally removed.

## Credit

Behavior target and source portions come from Quintin Shaw's MIT-licensed `pi-dynamic-workflows` package. See `THIRD_PARTY_NOTICES.md`.
