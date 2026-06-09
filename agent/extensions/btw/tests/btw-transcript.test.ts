import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  appendPersistedTranscriptTurn,
  applyTranscriptEvent,
  createEmptyTranscriptState,
  getCompletedExchangeCount,
  hasStreamingTranscriptEntry,
  removeTranscriptTurn,
  setTranscriptFailure,
  type BtwTranscriptEntry,
  type BtwTranscriptState,
} from "../extensions/btw-transcript.ts";

// ---------------------------------------------------------------------------
// Synthetic message + event factories.
//
// The reducer only reads `message.role`, `message.content`, and the tool-event
// scalar fields (`toolCallId` / `toolName` / `args` / `partialResult` /
// `result` / `isError`). It never inspects the extra fields some events carry
// (`assistantMessageEvent` on message_update, `message`/`toolResults` on
// turn_end), so we cast minimal literals to `AgentSessionEvent`.
// ---------------------------------------------------------------------------

function userMessage(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function assistantMessage(parts: { thinking?: string; text?: string }): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (parts.thinking !== undefined) {
    content.push({ type: "thinking", thinking: parts.thinking });
  }
  if (parts.text !== undefined) {
    content.push({ type: "text", text: parts.text });
  }
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

const ev = {
  turnStart: (): AgentSessionEvent => ({ type: "turn_start" }) as AgentSessionEvent,
  turnEnd: (): AgentSessionEvent => ({ type: "turn_end" }) as AgentSessionEvent,
  messageStart: (message: UserMessage | AssistantMessage): AgentSessionEvent =>
    ({ type: "message_start", message }) as AgentSessionEvent,
  messageUpdate: (message: AssistantMessage): AgentSessionEvent =>
    ({ type: "message_update", message }) as AgentSessionEvent,
  messageEnd: (message: UserMessage | AssistantMessage): AgentSessionEvent =>
    ({ type: "message_end", message }) as AgentSessionEvent,
  toolStart: (toolCallId: string, toolName: string, args: unknown): AgentSessionEvent =>
    ({ type: "tool_execution_start", toolCallId, toolName, args }) as AgentSessionEvent,
  toolUpdate: (toolCallId: string, toolName: string, partialResult: unknown): AgentSessionEvent =>
    ({ type: "tool_execution_update", toolCallId, toolName, partialResult }) as AgentSessionEvent,
  toolEnd: (toolCallId: string, toolName: string, result: unknown, isError: boolean): AgentSessionEvent =>
    ({ type: "tool_execution_end", toolCallId, toolName, result, isError }) as AgentSessionEvent,
};

function reduce(state: BtwTranscriptState, events: AgentSessionEvent[]): void {
  for (const event of events) {
    applyTranscriptEvent(state, event);
  }
}

function entriesOfType<TType extends BtwTranscriptEntry["type"]>(
  state: BtwTranscriptState,
  type: TType,
): Extract<BtwTranscriptEntry, { type: TType }>[] {
  return state.entries.filter((entry): entry is Extract<BtwTranscriptEntry, { type: TType }> => entry.type === type);
}

// ---------------------------------------------------------------------------
// Requirement: Event-sourced transcript reduction
// ---------------------------------------------------------------------------

describe("Event-sourced transcript reduction", () => {
  it("opens a turn on turn start (Scenario: Turn opens on turn start)", () => {
    const state = createEmptyTranscriptState();
    reduce(state, [ev.turnStart()]);

    const boundaries = entriesOfType(state, "turn-boundary");
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].phase).toBe("start");
    expect(state.currentTurnId).toBe(boundaries[0].turnId);
    expect(boundaries[0].id).toBe(1);
  });

  it("finalizes streaming on turn end without duplicating the end boundary (Scenario: Turn finalizes streaming on turn end)", () => {
    const state = createEmptyTranscriptState();
    reduce(state, [
      ev.turnStart(),
      ev.messageStart(assistantMessage({ thinking: "pondering", text: "partial" })),
      ev.toolStart("call-1", "read", { path: "a.ts" }),
      ev.toolUpdate("call-1", "read", "partial output"),
      ev.turnEnd(),
      // A second turn_end for the same (already-closed) turn must not append a
      // second end boundary.
      ev.turnEnd(),
    ]);

    const endBoundaries = entriesOfType(state, "turn-boundary").filter((entry) => entry.phase === "end");
    expect(endBoundaries).toHaveLength(1);

    for (const entry of state.entries) {
      if (entry.type === "thinking" || entry.type === "assistant-text" || entry.type === "tool-result") {
        expect(entry.streaming).toBe(false);
      }
    }
    expect(state.currentTurnId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Requirement: Streaming upsert of assistant output
// ---------------------------------------------------------------------------

describe("Streaming upsert of assistant output", () => {
  it("replaces prior thinking/text in place across updates (Scenario: Successive updates replace prior text)", () => {
    const state = createEmptyTranscriptState();
    reduce(state, [
      ev.turnStart(),
      ev.messageStart(assistantMessage({ thinking: "first thought", text: "first" })),
      ev.messageUpdate(assistantMessage({ thinking: "second thought", text: "second" })),
      ev.messageUpdate(assistantMessage({ thinking: "final thought", text: "final" })),
    ]);

    const thinking = entriesOfType(state, "thinking");
    const assistantText = entriesOfType(state, "assistant-text");
    expect(thinking).toHaveLength(1);
    expect(assistantText).toHaveLength(1);
    expect(thinking[0].text).toBe("final thought");
    expect(assistantText[0].text).toBe("final");
    expect(thinking[0].streaming).toBe(true);
    expect(assistantText[0].streaming).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Requirement: Tool call and result correlation
// ---------------------------------------------------------------------------

describe("Tool call and result correlation", () => {
  it("updates one tool-result entry from partial to final (Scenario: Partial then final result update one entry)", () => {
    const state = createEmptyTranscriptState();
    reduce(state, [
      ev.turnStart(),
      ev.toolStart("call-1", "bash", { command: "ls" }),
      ev.toolUpdate("call-1", "bash", "streaming..."),
      ev.toolEnd("call-1", "bash", "done", true),
    ]);

    const calls = entriesOfType(state, "tool-call");
    const results = entriesOfType(state, "tool-result");
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe("call-1");
    expect(results[0].content).toBe("done");
    expect(results[0].isError).toBe(true);
    expect(results[0].streaming).toBe(false);
  });

  it("ensures a tool-call entry when a result arrives without a recorded start (Scenario: Result without a recorded start is still correlated)", () => {
    const state = createEmptyTranscriptState();
    reduce(state, [ev.turnStart(), ev.toolEnd("orphan-1", "edit", "applied", false)]);

    const calls = entriesOfType(state, "tool-call");
    const results = entriesOfType(state, "tool-result");
    expect(calls).toHaveLength(1);
    expect(calls[0].toolCallId).toBe("orphan-1");
    expect(results).toHaveLength(1);
    expect(results[0].toolCallId).toBe("orphan-1");
    // The call entry precedes its result in the transcript order.
    expect(state.entries.indexOf(calls[0])).toBeLessThan(state.entries.indexOf(results[0]));
  });
});

// ---------------------------------------------------------------------------
// Requirement: Tool result summarization and truncation
// ---------------------------------------------------------------------------

describe("Tool result summarization and truncation", () => {
  it("clips an oversized result and flags truncation (Scenario: Oversized result is clipped)", () => {
    const state = createEmptyTranscriptState();
    const huge = "x".repeat(1000);
    reduce(state, [ev.turnStart(), ev.toolStart("call-1", "read", {}), ev.toolEnd("call-1", "read", huge, false)]);

    const results = entriesOfType(state, "tool-result");
    expect(results).toHaveLength(1);
    expect(results[0].truncated).toBe(true);
    expect(results[0].content.endsWith("...")).toBe(true);
    expect(results[0].content.length).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Requirement: User message recorded once per turn
// ---------------------------------------------------------------------------

describe("User message recorded once per turn", () => {
  it("records exactly one user-message entry from message_start + message_end (Scenario: message_start and message_end yield one entry)", () => {
    const state = createEmptyTranscriptState();
    reduce(state, [
      ev.turnStart(),
      ev.messageStart(userMessage("initial question")),
      ev.messageEnd(userMessage("final question")),
    ]);

    const userMessages = entriesOfType(state, "user-message");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].text).toBe("final question");
  });
});

// ---------------------------------------------------------------------------
// Requirement: Persisted turn replay
// ---------------------------------------------------------------------------

describe("Persisted turn replay", () => {
  it("reconstructs a finalized turn from a persisted detail (Scenario: Replaying a persisted detail)", () => {
    const state = createEmptyTranscriptState();
    appendPersistedTranscriptTurn(state, {
      question: "What is the package name?",
      thinking: "recalling",
      answer: "It is btw.",
      provider: "test-provider",
      model: "test-model",
      api: "openai-responses",
      thinkingLevel: "off",
      timestamp: 0,
    });

    const userMessages = entriesOfType(state, "user-message");
    const thinking = entriesOfType(state, "thinking");
    const assistantText = entriesOfType(state, "assistant-text");
    const endBoundaries = entriesOfType(state, "turn-boundary").filter((entry) => entry.phase === "end");

    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].text).toBe("What is the package name?");
    expect(thinking).toHaveLength(1);
    expect(thinking[0].text).toBe("recalling");
    expect(assistantText).toHaveLength(1);
    expect(assistantText[0].text).toBe("It is btw.");
    expect(endBoundaries).toHaveLength(1);

    expect(thinking[0].streaming).toBe(false);
    expect(assistantText[0].streaming).toBe(false);
    expect(hasStreamingTranscriptEntry(state.entries)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Requirement: Failure and cancellation handling
// ---------------------------------------------------------------------------

describe("Failure and cancellation handling", () => {
  it("appends a finalized assistant error entry on the active/last turn (Scenario: Side-session failure)", () => {
    const state = createEmptyTranscriptState();
    reduce(state, [ev.turnStart(), ev.messageStart(userMessage("please help"))]);
    setTranscriptFailure(state, "boom");

    const assistantText = entriesOfType(state, "assistant-text");
    expect(assistantText).toHaveLength(1);
    expect(assistantText[0].text).toBe("❌ boom");
    expect(assistantText[0].streaming).toBe(false);
    expect(state.currentTurnId).toBeNull();
    expect(state.lastTurnId).not.toBeNull();
  });

  it("removes all entries and tool-call records for a cancelled turn (Scenario: Cancelling the latest turn)", () => {
    const state = createEmptyTranscriptState();
    reduce(state, [
      ev.turnStart(),
      ev.messageStart(userMessage("first")),
      ev.toolStart("call-1", "bash", {}),
      ev.toolEnd("call-1", "bash", "ok", false),
      ev.messageEnd(assistantMessage({ text: "answer one" })),
      ev.turnEnd(),
    ]);
    const firstTurnId = state.lastTurnId;

    reduce(state, [
      ev.turnStart(),
      ev.messageStart(userMessage("second")),
      ev.toolStart("call-2", "read", {}),
    ]);
    const secondTurnId = state.lastTurnId;
    expect(secondTurnId).not.toBe(firstTurnId);

    removeTranscriptTurn(state, secondTurnId);

    expect(state.entries.some((entry) => entry.turnId === secondTurnId)).toBe(false);
    expect(state.entries.some((entry) => entry.turnId === firstTurnId)).toBe(true);
    expect(state.toolCalls.has("call-2")).toBe(false);
    expect(state.toolCalls.has("call-1")).toBe(true);
    expect(state.lastTurnId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Requirement: Transcript status queries
// ---------------------------------------------------------------------------

describe("Transcript status queries", () => {
  it("reports streaming while an entry is still streaming (Scenario: Streaming detection)", () => {
    const state = createEmptyTranscriptState();
    reduce(state, [ev.turnStart(), ev.messageStart(assistantMessage({ text: "streaming answer" }))]);

    expect(hasStreamingTranscriptEntry(state.entries)).toBe(true);

    reduce(state, [ev.turnEnd()]);
    expect(hasStreamingTranscriptEntry(state.entries)).toBe(false);
  });

  it("counts finalized assistant-text entries (Scenario: Completed exchange count)", () => {
    const state = createEmptyTranscriptState();
    reduce(state, [
      ev.turnStart(),
      ev.messageStart(userMessage("q1")),
      ev.messageEnd(assistantMessage({ text: "a1" })),
      ev.turnEnd(),
    ]);
    expect(getCompletedExchangeCount(state.entries)).toBe(1);

    reduce(state, [
      ev.turnStart(),
      ev.messageStart(userMessage("q2")),
      ev.messageEnd(assistantMessage({ text: "a2" })),
      ev.turnEnd(),
    ]);
    expect(getCompletedExchangeCount(state.entries)).toBe(2);

    // A still-streaming assistant entry is not counted until its turn ends.
    reduce(state, [ev.turnStart(), ev.messageStart(assistantMessage({ text: "a3-streaming" }))]);
    expect(getCompletedExchangeCount(state.entries)).toBe(2);
  });
});
