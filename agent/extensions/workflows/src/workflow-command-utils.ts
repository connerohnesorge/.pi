import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowRunResult } from "./workflow.js";

export function isCommandRegistered(pi: ExtensionAPI, name: string): boolean {
  try {
    return (pi.getCommands?.() ?? []).some((command: { name: string }) => command.name === name);
  } catch {
    return false;
  }
}

export function formatWorkflowResult(result: WorkflowRunResult): string {
  const value = result.result as { report?: unknown } | undefined;
  if (value && typeof value.report === "string" && value.report.trim()) return value.report;
  return JSON.stringify(result.result, null, 2);
}
