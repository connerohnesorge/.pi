import test from "node:test";
import assert from "node:assert/strict";
import {
  FINALLY_CUSTOM_TYPE,
  FINALLY_USAGE,
  clearFinallyQueue,
  dequeueFinallyMessage,
  enqueueFinallyMessage,
  formatFinallyCleared,
  formatFinallyQueued,
  formatFinallyStatus,
  formatFinallyStatusKey,
  makeFinallyQueueItem,
  parseFinallyCommand,
  reconstructFinallyQueue,
  snapshotQueue,
} from "../finally.ts";

test("parseFinallyCommand handles message, status, clear, and forced dash-prefixed messages", () => {
  assert.deepEqual(parseFinallyCommand("make sure tests pass"), {
    kind: "enqueue",
    text: "make sure tests pass",
  });
  assert.deepEqual(parseFinallyCommand("\n  -- make --clear literal  \n"), {
    kind: "enqueue",
    text: "make --clear literal",
  });
  assert.deepEqual(parseFinallyCommand(""), { kind: "status" });
  assert.deepEqual(parseFinallyCommand(" --status "), { kind: "status" });
  assert.deepEqual(parseFinallyCommand(" --clear "), { kind: "clear" });
  assert.throws(() => parseFinallyCommand("-- "), /Usage: \/finally/);
});

test("queue helpers normalize messages and flush FIFO", () => {
  let queue = clearFinallyQueue();
  queue = enqueueFinallyMessage(queue, " first message ", "a", 100);
  queue = enqueueFinallyMessage(queue, "second\nmessage", "b", 200);

  assert.deepEqual(queue, [
    { id: "a", text: "first message", queuedAt: 100 },
    { id: "b", text: "second\nmessage", queuedAt: 200 },
  ]);
  assert.equal(formatFinallyQueued(queue), "Finally queued (2 messages pending).");

  const first = dequeueFinallyMessage(queue);
  assert.deepEqual(first.item, { id: "a", text: "first message", queuedAt: 100 });
  assert.deepEqual(first.queue, [{ id: "b", text: "second\nmessage", queuedAt: 200 }]);

  const second = dequeueFinallyMessage(first.queue);
  assert.deepEqual(second.item, { id: "b", text: "second\nmessage", queuedAt: 200 });
  assert.deepEqual(second.queue, []);

  const empty = dequeueFinallyMessage(second.queue);
  assert.equal(empty.item, null);
  assert.deepEqual(empty.queue, []);
});

test("makeFinallyQueueItem rejects empty messages", () => {
  assert.throws(() => makeFinallyQueueItem("\n\t", "x", 0), new RegExp(FINALLY_USAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("snapshot reconstruction uses the latest custom entry on the current branch", () => {
  const firstQueue = [makeFinallyQueueItem("first", "first", 10)];
  const secondQueue = [makeFinallyQueueItem("second", "second", 20)];
  const entries = [
    { type: "message", message: { role: "user", content: "ignored" } },
    { type: "custom", customType: FINALLY_CUSTOM_TYPE, data: snapshotQueue(firstQueue, 11) },
    { type: "custom", customType: "other-extension", data: snapshotQueue([], 12) },
    {
      type: "custom",
      customType: FINALLY_CUSTOM_TYPE,
      data: { version: 1, queue: [{ id: 42, text: "bad", queuedAt: 0 }], updatedAt: 13 },
    },
    { type: "custom", customType: FINALLY_CUSTOM_TYPE, data: snapshotQueue(secondQueue, 21) },
  ];

  assert.deepEqual(reconstructFinallyQueue(entries), secondQueue);
});

test("status helpers summarize queue state", () => {
  assert.equal(formatFinallyStatus([]), "No finally messages pending.");
  assert.equal(formatFinallyStatusKey([]), undefined);
  assert.equal(formatFinallyCleared(0), "No finally messages were pending.");

  const queue = [makeFinallyQueueItem("a ".repeat(100), "long", 0)];
  assert.match(formatFinallyStatus(queue), /^1 finally message pending\. Next: /);
  assert.match(formatFinallyStatus(queue), /…$/);
  assert.equal(formatFinallyStatusKey(queue), "finally:1");
  assert.equal(formatFinallyCleared(1), "Cleared 1 finally message.");
});
