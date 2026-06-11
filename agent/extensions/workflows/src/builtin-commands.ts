/**
 * Bundled workflow commands: `/deep-research` and `/adversarial-review`.
 * They run a generated workflow script and print the final report.
 */

import { createCodingTools, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { generateAdversarialReviewWorkflow } from "./adversarial-review.js";
import { generateDeepResearchWorkflow } from "./deep-research.js";
import { createWebTools } from "./web-tools.js";
import { runWorkflow } from "./workflow.js";
import { formatWorkflowResult, isCommandRegistered } from "./workflow-command-utils.js";

export function registerBuiltinWorkflows(pi: ExtensionAPI, opts: { cwd: string }): void {
  const cwd = opts.cwd;

  if (!isCommandRegistered(pi, "deep-research")) {
    pi.registerCommand("deep-research", {
      description: "Research a question across the web with cross-checked sources",
      async handler(args: string, ctx: ExtensionCommandContext) {
        const question = args.trim();
        if (!question) return ctx.ui.notify("Usage: /deep-research <question>", "warning");
        ctx.ui.notify("Researching — running web searches across several angles…", "info");
        try {
          const result = await runWorkflow(generateDeepResearchWorkflow(), {
            cwd,
            args: { question },
            // Research agents need real web access on top of the coding tools.
            tools: [...createCodingTools(cwd), ...createWebTools()],
            onPhase: (title) => ctx.ui.setStatus("deep-research", `research: ${title}`),
          });
          ctx.ui.setStatus("deep-research", undefined);
          await pi.sendMessage({ customType: "deep-research", content: formatWorkflowResult(result), display: true });
        } catch (error) {
          ctx.ui.setStatus("deep-research", undefined);
          ctx.ui.notify(`deep-research failed: ${error instanceof Error ? error.message : error}`, "error");
        }
      },
    });
  }

  if (!isCommandRegistered(pi, "adversarial-review")) {
    pi.registerCommand("adversarial-review", {
      description: "Investigate a task, then cross-check each finding with skeptical reviewers",
      async handler(args: string, ctx: ExtensionCommandContext) {
        const task = args.trim();
        if (!task) return ctx.ui.notify("Usage: /adversarial-review <task or question>", "warning");
        ctx.ui.notify("Reviewing — investigating then refuting each finding…", "info");
        try {
          const result = await runWorkflow(generateAdversarialReviewWorkflow(), {
            cwd,
            args: { task },
            tools: createCodingTools(cwd),
            onPhase: (title) => ctx.ui.setStatus("adversarial-review", `review: ${title}`),
          });
          ctx.ui.setStatus("adversarial-review", undefined);
          await pi.sendMessage({
            customType: "adversarial-review",
            content: formatWorkflowResult(result),
            display: true,
          });
        } catch (error) {
          ctx.ui.setStatus("adversarial-review", undefined);
          ctx.ui.notify(`adversarial-review failed: ${error instanceof Error ? error.message : error}`, "error");
        }
      },
    });
  }
}
