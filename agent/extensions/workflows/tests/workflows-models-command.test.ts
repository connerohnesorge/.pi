// fallow-ignore-file code-duplication
/**
 * Tests for workflows-models-command.ts
 *
 * Since pi.registerCommand and ctx.ui functions are only available at runtime
 * inside Pi, these tests focus on the pure logic: command creation,
 * the editSingleTier single-select helper, and integration with model-tier-config.
 *
 * editSingleTier now uses ctx.ui.custom() with SelectList.
 * In tests, we mock ctx.ui.custom to directly return the expected value.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

async function loadCommand() {
  const mod = await import("../src/workflows-models-command.js");
  return mod;
}

async function editTierWithSelection(
  selection: string | null,
  tiers: Record<string, string> = { small: "gpt-4.1-mini" },
) {
  const { editSingleTier } = await import("../src/workflows-models-command.js");
  const ctx = {
    ui: {
      custom: mock.fn(async () => selection),
      notify: mock.fn(),
    },
  };
  return editSingleTier(ctx as never, tiers, "small");
}

describe("workflows-models-command", () => {
  describe("registerWorkflowModelsCommand", () => {
    it("registers the workflows-models command with Pi", async () => {
      const { registerWorkflowModelsCommand } = await loadCommand();
      const commands: string[] = [];
      const mockPi = {
        registerCommand: mock.fn((name: string, _opts: unknown) => {
          commands.push(name);
        }),
      };

      registerWorkflowModelsCommand(mockPi as never);

      assert.equal(mockPi.registerCommand.mock.callCount(), 1);
      assert.equal(commands[0], "workflows-models");
    });

    it("provides a description", async () => {
      const { registerWorkflowModelsCommand } = await loadCommand();
      let capturedDescription = "";

      const mockPi = {
        registerCommand: mock.fn((_name: string, opts: { description?: string }) => {
          capturedDescription = opts.description ?? "";
        }),
      };

      registerWorkflowModelsCommand(mockPi as never);
      assert.ok(capturedDescription.length > 0, "description should not be empty");
      assert.ok(capturedDescription.toLowerCase().includes("tier"), "description should mention tiers");
    });
  });

  describe("editSingleTier", () => {
    it("exports editSingleTier function", async () => {
      const mod = await import("../src/workflows-models-command.js");
      assert.equal(typeof mod.editSingleTier, "function");
    });

    it("returns null when user presses Escape (done with null)", async () => {
      const result = await editTierWithSelection(null);
      assert.equal(result, null);
    });

    it("returns null when user selects the same model (no change)", async () => {
      const result = await editTierWithSelection("gpt-4.1-mini");
      assert.equal(result, null); // no change
    });

    it("selects a different model and returns updated tiers", async () => {
      const result = await editTierWithSelection("gpt-5");
      assert.ok(result, "should return updated tiers");
      assert.equal(result.small, "gpt-5", "should have changed model");
      assert.equal(typeof result.small, "string", "should still be a string");
    });

    it("selects a model when no current model exists", async () => {
      const result = await editTierWithSelection("openai/gpt-4.1-mini", {});
      assert.ok(result, "should return updated tiers");
      assert.equal(result.small, "openai/gpt-4.1-mini");
    });
  });
});
