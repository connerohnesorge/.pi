export const LOOP_USAGE = "Usage: /loop [interval] [task]";
export const DEFAULT_LOOP_INTERVAL_MS = 10 * 60 * 1000;
export const MIN_LOOP_INTERVAL_MS = 60 * 1000;

export type LoopCommand =
  | { kind: "start"; intervalMs: number; intervalLabel: string; task: string }
  | { kind: "status" }
  | { kind: "clear" };

const INTERVAL_PATTERN = /^(\d+)([smhd])$/i;
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function parseLoopInterval(token: string): { intervalMs: number; intervalLabel: string } | null {
  const match = token.match(INTERVAL_PATTERN);
  if (!match) return null;

  const amount = Number.parseInt(match[1] ?? "", 10);
  const unit = (match[2] ?? "").toLowerCase();
  if (!Number.isSafeInteger(amount) || amount <= 0 || !(unit in UNIT_MS)) return null;

  const rawMs = amount * UNIT_MS[unit];
  const intervalMs = Math.max(rawMs, MIN_LOOP_INTERVAL_MS);
  return { intervalMs, intervalLabel: formatLoopInterval(intervalMs) };
}

export function formatLoopInterval(intervalMs: number): string {
  const units: Array<[string, number]> = [
    ["d", UNIT_MS.d],
    ["h", UNIT_MS.h],
    ["m", UNIT_MS.m],
  ];

  for (const [unit, ms] of units) {
    if (intervalMs % ms === 0) return `${intervalMs / ms}${unit}`;
  }

  return `${Math.ceil(intervalMs / MIN_LOOP_INTERVAL_MS)}m`;
}

export function parseLoopCommand(args: string): LoopCommand {
  const trimmed = args.trim();
  if (trimmed.length === 0 || trimmed === "--status") return { kind: "status" };
  if (trimmed === "--clear") return { kind: "clear" };

  const [firstToken = "", ...rest] = trimmed.split(/\s+/);
  const parsedInterval = parseLoopInterval(firstToken);
  const intervalMs = parsedInterval?.intervalMs ?? DEFAULT_LOOP_INTERVAL_MS;
  const intervalLabel = parsedInterval?.intervalLabel ?? formatLoopInterval(DEFAULT_LOOP_INTERVAL_MS);
  const task = normalizeWhitespace(parsedInterval ? rest.join(" ") : trimmed);

  if (task.length === 0) throw new Error(LOOP_USAGE);

  return { kind: "start", intervalMs, intervalLabel, task };
}

export interface LoopJob {
  id: number;
  task: string;
  intervalMs: number;
  intervalLabel: string;
  createdAt: number;
  nextRunAt: number;
}

export function formatLoopStarted(job: LoopJob): string {
  return `Loop #${job.id} running every ${job.intervalLabel}: ${job.task}`;
}

export function formatLoopStatus(jobs: readonly LoopJob[], now: number): string {
  if (jobs.length === 0) return "No loops running.";
  return jobs
    .map((job) => {
      const minutes = Math.max(0, Math.ceil((job.nextRunAt - now) / MIN_LOOP_INTERVAL_MS));
      const suffix = minutes === 0 ? "due now" : `next in ${minutes}m`;
      return `#${job.id} every ${job.intervalLabel} (${suffix}): ${job.task}`;
    })
    .join("\n");
}

export function formatLoopCleared(count: number): string {
  return count === 0 ? "No loops were running." : `Stopped ${count} loop${count === 1 ? "" : "s"}.`;
}

export function formatLoopStatusKey(jobs: readonly LoopJob[]): string | undefined {
  return jobs.length === 0 ? undefined : `loop:${jobs.length}`;
}

export function previewLoopIterations(intervalMs: number, now: number, count = 5): string[] {
  return Array.from({ length: count }, (_, index) => new Date(now + intervalMs * (index + 1)).toLocaleString());
}
