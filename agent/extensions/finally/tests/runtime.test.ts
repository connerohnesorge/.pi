import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FINALLY_CUSTOM_TYPE } from "../finally.ts";
import { registerFinallyExtension } from "../index.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

type FakeCommand = {
  description?: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
  getArgumentCompletions?: (prefix: string) => unknown;
};

function createHarness() {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, FakeCommand>();
  const sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
  const appended: Array<{ customType: string; data: unknown }> = [];
  const statuses: Array<{ key: string; value: string | undefined }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const branch: unknown[] = [];
  let now = 1000;
  let id = 0;

  const pi = {
    on(event: string, handler: EventHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, command: FakeCommand) {
      commands.set(name, command);
    },
    appendEntry(customType: string, data: unknown) {
      appended.push({ customType, data });
      branch.push({ type: "custom", customType, data });
    },
    sendUserMessage(content: unknown, options: unknown) {
      sentUserMessages.push({ content, options });
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    sessionManager: {
      getBranch: () => branch,
    },
    ui: {
      setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
  } as unknown as ExtensionContext;

  registerFinallyExtension(pi, {
    now: () => now++,
    createId: () => `id-${++id}`,
  });

  async function emit(event: string): Promise<void> {
    for (const handler of handlers.get(event) ?? []) {
      await handler({}, ctx);
    }
  }

  async function runCommand(args: string): Promise<void> {
    const command = commands.get("finally");
    assert.ok(command, "finally command registered");
    await command.handler(args, ctx);
  }

  return { appended, branch, commands, ctx, emit, notifications, runCommand, sentUserMessages, statuses };
}

test("/finally queues messages and flushes one FIFO message per agent_end", async () => {
  const harness = createHarness();
  await harness.emit("session_start");

  await harness.runCommand("first follow-up");
  await harness.runCommand("second follow-up");

  assert.equal(harness.sentUserMessages.length, 0);
  assert.equal(harness.appended.length, 2);
  assert.deepEqual(harness.statuses.at(-1), { key: "finally", value: "finally:2" });

  await harness.emit("agent_end");
  assert.deepEqual(harness.sentUserMessages, [
    { content: "first follow-up", options: { deliverAs: "followUp" } },
  ]);
  assert.deepEqual(harness.statuses.at(-1), { key: "finally", value: "finally:1" });

  await harness.emit("agent_end");
  assert.deepEqual(harness.sentUserMessages, [
    { content: "first follow-up", options: { deliverAs: "followUp" } },
    { content: "second follow-up", options: { deliverAs: "followUp" } },
  ]);
  assert.deepEqual(harness.statuses.at(-1), { key: "finally", value: undefined });

  await harness.emit("agent_end");
  assert.equal(harness.sentUserMessages.length, 2);
});

test("/finally --clear cancels pending messages and persists an empty snapshot", async () => {
  const harness = createHarness();
  await harness.runCommand("will be cleared");
  await harness.runCommand("--clear");
  await harness.emit("agent_end");

  assert.deepEqual(harness.sentUserMessages, []);
  assert.deepEqual(harness.statuses.at(-1), { key: "finally", value: undefined });
  assert.equal(harness.appended.at(-1)?.customType, FINALLY_CUSTOM_TYPE);
  assert.deepEqual((harness.appended.at(-1)?.data as { queue?: unknown[] }).queue, []);
});

test("session_start reconstructs a pending queue from branch custom entries", async () => {
  const first = createHarness();
  await first.runCommand("persisted follow-up");

  const second = createHarness();
  second.branch.push(...first.branch);
  await second.emit("session_start");
  await second.emit("agent_end");

  assert.deepEqual(second.sentUserMessages, [
    { content: "persisted follow-up", options: { deliverAs: "followUp" } },
  ]);
});

test("/finally --status reports queue state without mutating persistence", async () => {
  const harness = createHarness();
  await harness.runCommand("queued item");
  const writesAfterQueue = harness.appended.length;
  await harness.runCommand("--status");

  assert.equal(harness.appended.length, writesAfterQueue);
  assert.match(harness.notifications.at(-1)?.message ?? "", /1 finally message pending/);
});
