/**
 * Tests for tools availability when workflows mode is triggered.
 *
 * The bug: when a user message contains "workflow" (trigger keyword), the input
 * handler must add the workflow tool without hiding the default Pi tools.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { buildForcedWorkflowPrompt, WORKFLOW_TOOL_NAME, type WorkflowModeState } from "../src/workflow-editor.js";

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

async function setupWorkflowEditor(initialTools?: string[]) {
  const { installWorkflowEditor } = await import("../src/workflow-editor.js");
  const mockPi = createMockPi(initialTools);
  const setEditorComponent = mock.fn();
  const ui = { setEditorComponent };
  const state = installWorkflowEditor(mockPi as unknown as ExtensionAPI, ui as unknown as ExtensionUIContext);
  const input = (event: { source?: string; text?: string }) => mockPi.handlers.input[0](event);
  const turnEnd = () => mockPi.handlers.turn_end[0]();
  return { input, mockPi, setEditorComponent, state, turnEnd };
}

function lastSetActiveTools(mockPi: MockPi): string[] {
  return mockPi.setActiveTools.mock.calls.at(-1)?.arguments[0] ?? [];
}

describe("installWorkflowEditor - tool availability", () => {
  it("should include default Pi tools when input handler fires with 'workflow'", async () => {
    const { input, mockPi } = await setupWorkflowEditor([...DEFAULT_PI_TOOLS]);

    const result = input({ source: "interactive", text: "przetestuj to workflow zadanie" });

    assert.deepEqual(result, {
      action: "transform",
      text: buildForcedWorkflowPrompt("przetestuj to workflow zadanie"),
    });
    assert.equal(mockPi.getActiveTools.mock.callCount(), 1);
    assert.equal(mockPi.setActiveTools.mock.callCount(), 1);

    const calledWith = lastSetActiveTools(mockPi);
    assert.ok(Array.isArray(calledWith), "setActiveTools should be called with an array");
    assert.ok(calledWith.includes(WORKFLOW_TOOL_NAME), `"${WORKFLOW_TOOL_NAME}" must be in active tools`);
    for (const tool of DEFAULT_PI_TOOLS) {
      assert.ok(
        calledWith.includes(tool),
        `"${tool}" should still be available when workflows mode is triggered (got: [${calledWith.join(", ")}])`,
      );
    }
    assert.ok(calledWith.length > 1, `More than one tool should be active (got: [${calledWith.join(", ")}])`);
  });

  it("should restore original tools on turn_end", async () => {
    const originalTools = ["bash", "read", "edit", "write", "custom-plugin-tool", "workflow"];
    const { input, mockPi, turnEnd } = await setupWorkflowEditor(originalTools);

    input({ source: "interactive", text: "run workflows" });
    const toolsWhenActive = lastSetActiveTools(mockPi);
    for (const tool of originalTools) assert.ok(toolsWhenActive.includes(tool), `"${tool}" should be in active tools`);

    assert.equal(mockPi.handlers.turn_end.length, 1);
    turnEnd();
    assert.deepEqual(lastSetActiveTools(mockPi), originalTools, "original tools should be restored exactly");
  });

  it('should not fire for "/workflows" (slash command, not trigger)', async () => {
    const { input, mockPi } = await setupWorkflowEditor();
    assert.deepEqual(input({ source: "interactive", text: "/workflows list" }), { action: "continue" });
    assert.equal(mockPi.setActiveTools.mock.callCount(), 0);
  });

  it("should not fire for non-interactive sources", async () => {
    const { input, mockPi } = await setupWorkflowEditor();
    assert.deepEqual(input({ source: "api", text: "run a workflow" }), { action: "continue" });
    assert.equal(mockPi.setActiveTools.mock.callCount(), 0);
  });

  it("should not fire for empty text", async () => {
    const { input, mockPi } = await setupWorkflowEditor();
    assert.deepEqual(input({ source: "interactive", text: "" }), { action: "continue" });
    assert.equal(mockPi.setActiveTools.mock.callCount(), 0);
  });

  it("should handle getActiveTools returning undefined gracefully", async () => {
    const { input, mockPi } = await setupWorkflowEditor();
    mockPi.getActiveTools = mock.fn(() => undefined as unknown as string[]);
    assert.doesNotThrow(() => input({ source: "interactive", text: "test workflow" }));
  });

  it("should handle setActiveTools throwing gracefully (best-effort)", async () => {
    const { input, mockPi } = await setupWorkflowEditor();
    mockPi.setActiveTools = mock.fn(() => {
      throw new Error("host rejected tool restriction");
    });

    const result = input({ source: "interactive", text: "test workflow" });
    assert.equal(result.action, "transform");
  });

  it("should handle multiple trigger events and restore correctly", async () => {
    const originalTools = ["bash", "read", "edit", "write"];
    const { input, mockPi, turnEnd } = await setupWorkflowEditor(originalTools);

    input({ source: "interactive", text: "test workflow 1" });
    input({ source: "interactive", text: "test workflow 2" });
    assert.equal(mockPi.setActiveTools.mock.callCount(), 1);

    turnEnd();
    mockPi.setActiveTools.mock.resetCalls();
    turnEnd();
    assert.equal(mockPi.setActiveTools.mock.callCount(), 0, "second turn_end should not call setActiveTools");
  });

  it("should work with different keyword variations: 'workflow', 'workflows', 'WORKFLOW'", async () => {
    for (const keyword of ["workflow", "workflows", "WORKFLOW", "WorkFlows"]) {
      const { input, mockPi } = await setupWorkflowEditor();
      mockPi.setActiveTools.mock.resetCalls();

      input({ source: "interactive", text: `run ${keyword} test` });
      const tools = lastSetActiveTools(mockPi);
      assert.ok(tools.includes("bash"), `bash should be available for keyword "${keyword}"`);
      assert.ok(tools.includes("read"), `read should be available for keyword "${keyword}"`);
      assert.ok(tools.includes(WORKFLOW_TOOL_NAME), `workflow should be in active tools for keyword "${keyword}"`);
    }
  });

  it("should set editor component", async () => {
    const { setEditorComponent, state } = await setupWorkflowEditor();
    assert.equal(setEditorComponent.mock.callCount(), 1);
    assert.ok(state, "should return a WorkflowModeState");
    assert.equal(state.active, false);
  });

  it("should return correct WorkflowModeState", async () => {
    const { state } = await setupWorkflowEditor();
    const typedState: WorkflowModeState = state;
    assert.equal(typeof typedState.active, "boolean");
    assert.equal(typedState.active, false);
  });
});
