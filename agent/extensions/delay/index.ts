import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DELAY_USAGE,
  formatDelayCleared,
  formatDelayScheduled,
  formatDelayStatus,
  formatDelayStatusKey,
  parseDelayCommand,
  parseDelayDuration,
  previewDelayDelivery,
  type DelayJob,
} from "./delay.ts";

export interface DelayExtensionDeps {
  now?: () => number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

type TimeoutHandle = ReturnType<typeof globalThis.setTimeout>;

function syncDelayStatus(ctx: ExtensionContext, jobs: readonly DelayJob[]): void {
  ctx.ui.setStatus("delay", formatDelayStatusKey(jobs));
}

export function registerDelayExtension(pi: ExtensionAPI, deps: DelayExtensionDeps = {}): void {
  const now = deps.now ?? (() => Date.now());
  const setTimeoutFn = deps.setTimeout ?? globalThis.setTimeout;
  const clearTimeoutFn = deps.clearTimeout ?? globalThis.clearTimeout;
  const jobs = new Map<number, DelayJob>();
  const timers = new Map<number, TimeoutHandle>();
  let nextId = 1;
  let latestCtx: ExtensionContext | null = null;

  function snapshotJobs(): DelayJob[] {
    return [...jobs.values()].sort((a, b) => a.sendAt - b.sendAt || a.id - b.id);
  }

  function sync(ctx: ExtensionContext | null = latestCtx): void {
    if (ctx) syncDelayStatus(ctx, snapshotJobs());
  }

  function clearAll(): number {
    const count = jobs.size;
    for (const timer of timers.values()) clearTimeoutFn(timer);
    timers.clear();
    jobs.clear();
    return count;
  }

  function triggerJob(id: number): void {
    const job = jobs.get(id);
    if (!job) return;

    jobs.delete(id);
    timers.delete(id);
    sync();
    pi.sendUserMessage(job.message, { deliverAs: "followUp" });
  }

  function startDelay(ctx: ExtensionContext, message: string, delayMs: number, delayLabel: string): void {
    latestCtx = ctx;
    const id = nextId++;
    const createdAt = now();
    const job: DelayJob = { id, message, delayMs, delayLabel, createdAt, sendAt: createdAt + delayMs };
    jobs.set(id, job);
    timers.set(id, setTimeoutFn(() => triggerJob(id), delayMs));
    sync(ctx);
    ctx.ui.notify(formatDelayScheduled(job), "info");
  }

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    sync(ctx);
  });

  pi.on("session_shutdown", () => {
    clearAll();
    latestCtx = null;
  });

  pi.registerCommand("delay", {
    description: "Send a message after a delay (default 10m; units: s, m, h, d)",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trimStart();
      const tokens = value.split(/\s+/).filter(Boolean);
      const trailingSpace = /\s$/.test(value);
      const firstPrefix = trailingSpace ? "" : tokens[0] ?? "";
      const options = ["--status", "--clear", "1m", "5m", "10m", "1h"];

      if (tokens.length === 1) {
        const delay = parseDelayDuration(tokens[0]);
        if (delay) {
          const preview = previewDelayDelivery(delay.delayMs, now());
          return [{ value: `${tokens[0]} `, label: `${tokens[0]} · sends at ${preview}` }];
        }
      }

      if (tokens.length === 0 || (tokens.length === 1 && !trailingSpace)) {
        return options.filter((option) => option.startsWith(firstPrefix)).map((value) => ({ value, label: value }));
      }

      return null;
    },
    handler: async (args, ctx) => {
      latestCtx = ctx;
      let command;
      try {
        command = parseDelayCommand(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : DELAY_USAGE, "error");
        return;
      }

      switch (command.kind) {
        case "start":
          startDelay(ctx, command.message, command.delayMs, command.delayLabel);
          return;
        case "clear": {
          const count = clearAll();
          sync(ctx);
          ctx.ui.notify(formatDelayCleared(count), count > 0 ? "info" : "warning");
          return;
        }
        case "status":
          sync(ctx);
          ctx.ui.notify(formatDelayStatus(snapshotJobs(), now()), "info");
          return;
      }
    },
  });
}

export default function delayExtension(pi: ExtensionAPI): void {
  registerDelayExtension(pi);
}
