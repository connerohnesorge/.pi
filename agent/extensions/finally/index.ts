import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  parseFinallyCommand,
  previewFinallyMessage,
  reconstructFinallyQueue,
  snapshotQueue,
  type FinallyQueueItem,
} from "./finally.ts";

export interface FinallyExtensionDeps {
  now?: () => number;
  createId?: () => string;
}

function syncFinallyStatus(ctx: ExtensionContext, queue: readonly FinallyQueueItem[]): void {
  ctx.ui.setStatus("finally", formatFinallyStatusKey(queue));
}

export function registerFinallyExtension(pi: ExtensionAPI, deps: FinallyExtensionDeps = {}): void {
  const now = deps.now ?? (() => Date.now());
  const createId = deps.createId ?? (() => randomUUID());
  let queue: FinallyQueueItem[] = [];

  function persistQueue(ctx: ExtensionContext): void {
    pi.appendEntry(FINALLY_CUSTOM_TYPE, snapshotQueue(queue, now()));
    syncFinallyStatus(ctx, queue);
  }

  function reconstructQueue(ctx: ExtensionContext): void {
    queue = reconstructFinallyQueue(ctx.sessionManager.getBranch());
    syncFinallyStatus(ctx, queue);
  }

  function enqueueMessage(ctx: ExtensionContext, text: string): void {
    queue = enqueueFinallyMessage(queue, text, createId(), now());
    persistQueue(ctx);
    ctx.ui.notify(formatFinallyQueued(queue), "info");
  }

  function clearQueue(ctx: ExtensionContext): void {
    const count = queue.length;
    queue = clearFinallyQueue();
    persistQueue(ctx);
    ctx.ui.notify(formatFinallyCleared(count), count > 0 ? "info" : "warning");
  }

  function showStatus(ctx: ExtensionContext): void {
    syncFinallyStatus(ctx, queue);
    ctx.ui.notify(formatFinallyStatus(queue), "info");
  }

  function flushOne(ctx: ExtensionContext): void {
    const result = dequeueFinallyMessage(queue);
    if (!result.item) {
      syncFinallyStatus(ctx, queue);
      return;
    }

    queue = result.queue;
    persistQueue(ctx);
    ctx.ui.notify(`Finally sending: ${previewFinallyMessage(result.item.text)}`, "info");
    pi.sendUserMessage(result.item.text, { deliverAs: "followUp" });
  }

  pi.on("session_start", (_event, ctx) => {
    reconstructQueue(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    reconstructQueue(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    flushOne(ctx);
  });

  pi.registerCommand("finally", {
    description: "Queue a message for after the agent fully stops",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trimStart();
      const tokens = value.split(/\s+/).filter(Boolean);
      const trailingSpace = /\s$/.test(value);
      const firstPrefix = trailingSpace ? "" : tokens[0] ?? "";
      const options = ["--status", "--clear", "--"];

      if (tokens.length === 0 || (tokens.length === 1 && !trailingSpace)) {
        const filtered = options.filter((option) => option.startsWith(firstPrefix));
        return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
      }

      return null;
    },
    handler: async (args, ctx) => {
      let command;
      try {
        command = parseFinallyCommand(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : FINALLY_USAGE, "error");
        return;
      }

      switch (command.kind) {
        case "enqueue":
          enqueueMessage(ctx, command.text);
          return;
        case "clear":
          clearQueue(ctx);
          return;
        case "status":
          showStatus(ctx);
          return;
      }
    },
  });
}

export default function finallyExtension(pi: ExtensionAPI): void {
  registerFinallyExtension(pi);
}
