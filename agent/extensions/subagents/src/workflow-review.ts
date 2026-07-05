import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import { parseKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { parseWorkflowScript, type WorkflowMeta } from "./workflow.ts";

type ReviewResult = { approved: true; script: string; meta: WorkflowMeta } | { approved: false };

export async function reviewWorkflowScript(ui: ExtensionUIContext, script: string): Promise<ReviewResult> {
  let current = script;
  let parsed = parseWorkflowScript(current);
  let error: string | undefined;

  return ui.custom<ReviewResult>((tui: TUI, theme: Theme, _keybindings, done) => {
    const finish = (result: ReviewResult) => done(result);
    const edit = () => {
      const edited = editInExternalEditor(tui, current);
      if (edited == null) return;
      try {
        const next = parseWorkflowScript(edited);
        current = edited;
        parsed = next;
        error = undefined;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      tui.requestRender();
    };

    let focused = false;
    const component: Component & Focusable = {
      get focused() {
        return focused;
      },
      set focused(v: boolean) {
        focused = v;
      },
      render(width: number) {
        return renderReview(current, parsed.meta, error, Math.max(40, width), theme);
      },
      handleInput(data: string) {
        const key = parseKey(data);
        if (key === "enter" || key === "return") finish({ approved: true, script: current, meta: parsed.meta });
        else if (key === "escape" || key === "esc" || key === "q") finish({ approved: false });
        else if (key === "ctrl+g") edit();
      },
      invalidate: () => {},
    };
    return component;
  }, { overlay: true, overlayOptions: { width: "94%", maxHeight: "92%", anchor: "center", margin: 1 } });
}

function renderReview(script: string, meta: WorkflowMeta, error: string | undefined, width: number, theme: Theme): string[] {
  const dim = (s: string) => theme.fg("dim", s);
  const lines = [
    theme.bold(`Review workflow JS: ${meta.name}`),
    dim(meta.description),
    meta.phases?.length ? dim(`Phases: ${meta.phases.map((p) => p.title).join(", ")}`) : dim("Phases: none declared"),
    "",
    ...(error ? [theme.fg("error", `Edit error: ${error}`), ""] : []),
    ...wrapTextWithAnsi(script, Math.max(20, width - 2)),
    "",
    dim("Enter run · Ctrl+G edit JS · Esc cancel"),
  ];
  return lines.map((line) => truncateToWidth(line, width, "", true));
}

function editInExternalEditor(tui: TUI, script: string): string | undefined {
  const file = join(mkdtempSync(join(tmpdir(), "pi-workflow-")), "workflow.js");
  writeFileSync(file, script);
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  try {
    (tui as { stop?: () => void }).stop?.();
    const result = spawnSync(editor, [file], { stdio: "inherit", shell: true });
    if (result.status !== 0) return undefined;
    return readFileSync(file, "utf8").trim();
  } finally {
    (tui as { start?: () => void }).start?.();
  }
}
