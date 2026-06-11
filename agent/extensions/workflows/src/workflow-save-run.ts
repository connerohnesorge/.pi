import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PersistedRunState } from "./run-persistence.js";
import { registerSavedWorkflow } from "./saved-commands.js";
import type { SavedWorkflow, WorkflowStorage } from "./workflow-saved.js";

export type SaveableRun = Pick<PersistedRunState, "workflowName" | "script">;

export function saveRunAsWorkflow(
  pi: ExtensionAPI,
  storage: WorkflowStorage,
  cwd: string,
  name: string,
  run: SaveableRun,
): SavedWorkflow {
  const saved = storage.save({
    name,
    description: run.workflowName,
    script: run.script,
    location: "project",
  });
  registerSavedWorkflow(pi, cwd, saved, undefined, () =>
    storage.list().some((workflow) => workflow.name === saved.name),
  );
  return saved;
}
