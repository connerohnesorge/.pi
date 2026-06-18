import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  LOOP_USAGE,
  formatLoopCleared,
  formatLoopStarted,
  formatLoopStatus,
  formatLoopStatusKey,
  parseLoopCommand,
  parseLoopInterval,
  previewLoopIterations,
  type LoopJob,
} from "./loop.ts";

export interface LoopExtensionDeps {
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

type IntervalHandle = ReturnType<typeof globalThis.setInterval>;

function syncLoopStatus(ctx: ExtensionContext, jobs: readonly LoopJob[]): void {
  ctx.ui.setStatus("loop", formatLoopStatusKey(jobs));
}

export function registerLoopExtension(pi: ExtensionAPI, deps: LoopExtensionDeps = {}): void {
  const now = deps.now ?? (() => Date.now());
  const setIntervalFn = deps.setInterval ?? globalThis.setInterval;
  const clearIntervalFn = deps.clearInterval ?? globalThis.clearInterval;
  const jobs = new Map<number, LoopJob>();
  const timers = new Map<number, IntervalHandle>();
  let nextId = 1;
  let latestCtx: ExtensionContext | null = null;

  function snapshotJobs(): LoopJob[] {
    return [...jobs.values()].sort((a, b) => a.id - b.id);
  }

  function sync(ctx: ExtensionContext | null = latestCtx): void {
    if (ctx) syncLoopStatus(ctx, snapshotJobs());
  }

  function stopAll(): number {
    const count = timers.size;
    for (const timer of timers.values()) clearIntervalFn(timer);
    timers.clear();
    jobs.clear();
    return count;
  }

  function triggerJob(id: number): void {
    const job = jobs.get(id);
    if (!job) return;
    const updated = { ...job, nextRunAt: now() + job.intervalMs };
    jobs.set(id, updated);
    sync();
    pi.sendUserMessage(updated.task, { deliverAs: "followUp" });
  }

  function startLoop(ctx: ExtensionContext, task: string, intervalMs: number, intervalLabel: string): void {
    latestCtx = ctx;
    const id = nextId++;
    const createdAt = now();
    const job: LoopJob = { id, task, intervalMs, intervalLabel, createdAt, nextRunAt: createdAt + intervalMs };
    jobs.set(id, job);
    timers.set(id, setIntervalFn(() => triggerJob(id), intervalMs));
    sync(ctx);
    ctx.ui.notify(formatLoopStarted(job), "info");
  }

  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    sync(ctx);
  });

  pi.on("session_shutdown", () => {
    stopAll();
    latestCtx = null;
  });

  pi.registerCommand("loop", {
    description: "Repeat a task on an interval (default 10m; units: s, m, h, d)",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trimStart();
      const tokens = value.split(/\s+/).filter(Boolean);
      const trailingSpace = /\s$/.test(value);
      const firstPrefix = trailingSpace ? "" : tokens[0] ?? "";
      const options = ["--status", "--clear", "1m", "5m", "10m", "1h"];

      if (tokens.length === 1) {
        const interval = parseLoopInterval(tokens[0]);
        if (interval) {
          const preview = previewLoopIterations(interval.intervalMs, now()).join(" → ");
          return [{ value: `${tokens[0]} `, label: `${tokens[0]} · next 5: ${preview}` }];
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
        command = parseLoopCommand(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : LOOP_USAGE, "error");
        return;
      }

      switch (command.kind) {
        case "start":
          startLoop(ctx, command.task, command.intervalMs, command.intervalLabel);
          return;
        case "clear": {
          const count = stopAll();
          sync(ctx);
          ctx.ui.notify(formatLoopCleared(count), count > 0 ? "info" : "warning");
          return;
        }
        case "status":
          sync(ctx);
          ctx.ui.notify(formatLoopStatus(snapshotJobs(), now()), "info");
          return;
      }
    },
  });
}

export default function loopExtension(pi: ExtensionAPI): void {
  registerLoopExtension(pi);
}
