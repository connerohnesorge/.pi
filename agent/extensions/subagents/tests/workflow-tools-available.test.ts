/**
 * Tests for tools availability when workflows mode is triggered.
 *
 * The bug: when a user message contains "workflow" (trigger keyword),
 * installWorkflowEditor's input handler calls:
 *   pi.setActiveTools?.([WORKFLOW_TOOL_NAME]);
 * which restricts ALL tools to ONLY the workflow tool.
 * The model then cannot use read, bash, edit, write, web_search, etc.
 * and gets "Tool X not found" errors.
 *
 * The fix: preserve default Pi tools alongside the workflow tool.
 * These tests verify that default tools remain available after the
 * workflows-mode trigger fires.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  buildForcedWorkflowPrompt,
  installWorkflowEditor,
  WORKFLOW_TOOL_NAME,
  type WorkflowModeState,
} from "../src/workflow-editor.ts";

// ---------------------------------------------------------------------------
// Default Pi tools that every Pi install provides (plugin-independent)
// ---------------------------------------------------------------------------
const DEFAULT_PI_TOOLS = [
  "bash",
  "read",
  "edit",
  "write",
  "ask_user_question",
  "todo",
  "web_search",
  "web_fetch",
  "advisor",
  "subagent",
  "workflow",
];

// Additional tools from context-mode plugin (common but not guaranteed)
// We do NOT include these in DEFAULT_PI_TOOLS for compatibility.
// Tools like ctx_execute, ctx_execute_file, ctx_index, ctx_search, etc.
// are from a plugin and may not be present.

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockPi {
  on: ReturnType<typeof mock.fn>;
  getActiveTools: ReturnType<typeof mock.fn>;
  setActiveTools: ReturnType<typeof mock.fn>;
  handlers: Record<string, Array<(...args: any[]) => any>>;
}

function createMockPi(initialTools: string[] = [...DEFAULT_PI_TOOLS]): MockPi {
  const handlers: Record<string, Array<(...args: any[]) => any>> = {};
  return {
    on: mock.fn((event: string, handler: (...args: any[]) => any) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    getActiveTools: mock.fn(() => [...initialTools]),
    setActiveTools: mock.fn(),
    handlers,
  };
}

function testSettingsOptions(keywordTriggerEnabled = true, keywordTriggerWord?: string) {
  return {
    settingsStore: {
      load: () => ({ keywordTriggerEnabled, ...(keywordTriggerWord ? { keywordTriggerWord } : {}) }),
      save: () => {},
    },
  };
}

function installWithMockPi(
  mockPi = createMockPi(),
  settings = testSettingsOptions(),
  ui = { setEditorComponent: mock.fn() },
) {
  const state = installWorkflowEditor(
    mockPi as unknown as ExtensionAPI,
    ui as unknown as ExtensionUIContext,
    undefined,
    settings,
  );

  return {
    mockPi,
    ui,
    state,
    inputHandlers: mockPi.handlers.input,
    turnEndHandlers: mockPi.handlers.turn_end,
  };
}

// ---------------------------------------------------------------------------
// Test: installWorkflowEditor keeps default tools available
// ---------------------------------------------------------------------------

describe("installWorkflowEditor - tool availability", () => {
  it("should include default Pi tools when input handler fires with 'workflow'", async () => {
    const { mockPi, inputHandlers } = installWithMockPi(createMockPi([...DEFAULT_PI_TOOLS]));

    // Simulate user submitting a message with "workflow" keyword
    assert.ok(inputHandlers, "input handler should be registered");
    assert.equal(inputHandlers.length, 1);

    const result = inputHandlers[0]({
      source: "interactive",
      text: "przetestuj to workflow zadanie",
    });

    // Verify transform result
    assert.deepEqual(result, {
      action: "transform",
      text: buildForcedWorkflowPrompt("przetestuj to workflow zadanie"),
    });

    // Verify getActiveTools was called
    assert.equal(mockPi.getActiveTools.mock.callCount(), 1);

    // Verify setActiveTools was called
    assert.equal(mockPi.setActiveTools.mock.callCount(), 1);

    const calledWith = mockPi.setActiveTools.mock.calls[0].arguments[0];
    assert.ok(Array.isArray(calledWith), "setActiveTools should be called with an array");

    // The critical assertion: the workflow tool must be present
    assert.ok(calledWith.includes(WORKFLOW_TOOL_NAME), `"${WORKFLOW_TOOL_NAME}" must be in active tools`);

    // The critical assertion: default Pi tools must still be available
    for (const tool of DEFAULT_PI_TOOLS) {
      assert.ok(
        calledWith.includes(tool),
        `"${tool}" should still be available when workflows mode is triggered (got: [${calledWith.join(", ")}])`,
      );
    }

    // Verify tools are not restricted to just workflow
    assert.ok(
      calledWith.length > 1,
      `More than one tool should be active, not just workflow (got: [${calledWith.join(", ")}])`,
    );
  });

  it("should restore original tools on turn_end", async () => {
    // Add a bonus tool to simulate a plugin adding a tool
    const originalTools = ["bash", "read", "edit", "write", "custom-plugin-tool", "workflow"];
    const { mockPi, inputHandlers, turnEndHandlers } = installWithMockPi(createMockPi(originalTools));

    // Trigger input with "workflows"
    inputHandlers[0]({
      source: "interactive",
      text: "run workflows",
    });

    // Verify tools were set (with default tools preserved)
    const toolsWhenActive = mockPi.setActiveTools.mock.calls[0].arguments[0];
    for (const t of originalTools) {
      assert.ok(toolsWhenActive.includes(t), `"${t}" should be in active tools`);
    }

    // Simulate turn_end
    assert.ok(turnEndHandlers, "turn_end handler should be registered");
    assert.equal(turnEndHandlers.length, 1);

    turnEndHandlers[0]();

    // Verify original tools were restored exactly
    const restoredTools = mockPi.setActiveTools.mock.calls[1].arguments[0];
    assert.deepEqual(restoredTools, originalTools, "original tools should be restored exactly");
  });

  it("should fire for a configured trigger word but not the default word", async () => {
    const { mockPi, inputHandlers } = installWithMockPi(createMockPi(), testSettingsOptions(true, "pi-workflow"));

    assert.deepEqual(inputHandlers[0]({ source: "interactive", text: "run workflow" }), { action: "continue" });
    assert.equal(mockPi.setActiveTools.mock.callCount(), 0);

    const result = inputHandlers[0]({ source: "interactive", text: "run pi-workflow" });
    assert.equal(result.action, "transform");
    assert.equal(mockPi.setActiveTools.mock.callCount(), 1);
  });

  it('should not fire for "/workflows" (slash command, not trigger)', async () => {
    const { mockPi, inputHandlers } = installWithMockPi();

    // Simulate user submitting a slash command
    const result = inputHandlers[0]({
      source: "interactive",
      text: "/workflows list",
    });

    // Should not transform (slash commands are not triggers)
    assert.deepEqual(result, { action: "continue" });

    // Should NOT have called setActiveTools
    assert.equal(mockPi.setActiveTools.mock.callCount(), 0);
  });

  it("should not fire for non-interactive sources", async () => {
    const { mockPi, inputHandlers } = installWithMockPi();

    const result = inputHandlers[0]({
      source: "api", // non-interactive
      text: "run a workflow",
    });

    assert.deepEqual(result, { action: "continue" });
    assert.equal(mockPi.setActiveTools.mock.callCount(), 0);
  });

  it("should not fire for empty text", async () => {
    const { mockPi, inputHandlers } = installWithMockPi();

    const result = inputHandlers[0]({
      source: "interactive",
      text: "",
    });

    assert.deepEqual(result, { action: "continue" });
    assert.equal(mockPi.setActiveTools.mock.callCount(), 0);
  });

  it("should handle getActiveTools returning undefined gracefully", async () => {
    // Pi may not have getActiveTools in some hosts
    const mockPi = createMockPi();
    mockPi.getActiveTools = mock.fn(() => undefined as unknown as string[]);
    const { inputHandlers } = installWithMockPi(mockPi);

    assert.doesNotThrow(() => {
      inputHandlers[0]({
        source: "interactive",
        text: "test workflow",
      });
    });
  });

  it("should handle setActiveTools throwing gracefully (best-effort)", async () => {
    const mockPi = createMockPi();
    mockPi.setActiveTools = mock.fn(() => {
      throw new Error("host rejected tool restriction");
    });
    const { inputHandlers } = installWithMockPi(mockPi);

    // Should not throw — the catch block handles it
    const result = inputHandlers[0]({
      source: "interactive",
      text: "test workflow",
    });

    // Should still return the transform action even if setActiveTools failed
    assert.equal(result.action, "transform");
  });

  it("should handle multiple trigger events and restore correctly", async () => {
    const originalTools = ["bash", "read", "edit", "write"];
    const { mockPi, inputHandlers, turnEndHandlers } = installWithMockPi(createMockPi(originalTools));

    // First trigger
    inputHandlers[0]({
      source: "interactive",
      text: "test workflow 1",
    });

    // Second trigger (before turn_end)
    inputHandlers[0]({
      source: "interactive",
      text: "test workflow 2",
    });

    // setActiveTools should only have been called once (savedTools is already set)
    assert.equal(mockPi.setActiveTools.mock.callCount(), 1);

    // turn_end restores
    turnEndHandlers[0]();

    // Subsequent turn_end should NOT restore again (savedTools is now undefined)
    mockPi.setActiveTools.mock.resetCalls();
    turnEndHandlers[0]();
    assert.equal(mockPi.setActiveTools.mock.callCount(), 0, "second turn_end should not call setActiveTools");
  });

  it("should work with different keyword variations: 'workflow', 'workflows', 'WORKFLOW'", async () => {
    for (const keyword of ["workflow", "workflows", "WORKFLOW", "WorkFlows"]) {
      const { mockPi, inputHandlers } = installWithMockPi();

      mockPi.setActiveTools.mock.resetCalls();

      inputHandlers[0]({
        source: "interactive",
        text: `run ${keyword} test`,
      });

      const tools = mockPi.setActiveTools.mock.calls[0]?.arguments[0];
      assert.ok(tools?.includes("bash"), `bash should be available for keyword "${keyword}"`);
      assert.ok(tools?.includes("read"), `read should be available for keyword "${keyword}"`);
      assert.ok(tools?.includes(WORKFLOW_TOOL_NAME), `workflow should be in active tools for keyword "${keyword}"`);
    }
  });

  it("should set editor component", async () => {
    const setEditorComponent = mock.fn();
    const { state } = installWithMockPi(createMockPi(), testSettingsOptions(), { setEditorComponent });

    assert.equal(setEditorComponent.mock.callCount(), 1);
    assert.ok(state, "should return a WorkflowModeState");
    assert.equal(state.active, false);
  });

  it("should return correct WorkflowModeState", async () => {
    const { state }: { state: WorkflowModeState } = installWithMockPi();

    assert.equal(typeof state.active, "boolean");
    assert.equal(state.active, false);
  });
});
