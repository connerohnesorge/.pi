export const LOOP_USAGE = "Usage: /loop [interval] [task]";
export const DEFAULT_LOOP_INTERVAL_MS = 10 * 60 * 1000;
export const MIN_LOOP_INTERVAL_MS = 60 * 1000;

export type LoopCommand =
  | { kind: "start"; intervalMs: number; intervalLabel: string; task: string }
  | { kind: "status" }
  | { kind: "clear" };

const INTERVAL_PATTERN = /^(\d+)([smhd])$/i;
const TIME_UNIT_MS = new Map<string, number>([
  ["s", 1000],
  ["m", MIN_LOOP_INTERVAL_MS],
  ["h", 60 * MIN_LOOP_INTERVAL_MS],
  ["d", 24 * 60 * MIN_LOOP_INTERVAL_MS],
]);
const LABEL_UNITS: Array<[string, number]> = [
  ["d", 24 * 60 * MIN_LOOP_INTERVAL_MS],
  ["h", 60 * MIN_LOOP_INTERVAL_MS],
  ["m", MIN_LOOP_INTERVAL_MS],
];

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export function parseLoopInterval(token: string): { intervalMs: number; intervalLabel: string } | null {
  const match = INTERVAL_PATTERN.exec(token);
  if (!match) return null;

  const amount = Number.parseInt(match[1] ?? "", 10);
  const unitMs = TIME_UNIT_MS.get((match[2] ?? "").toLowerCase());
  if (!isPositiveSafeInteger(amount)) return null;
  if (unitMs === undefined) return null;

  const intervalMs = Math.max(amount * unitMs, MIN_LOOP_INTERVAL_MS);
  return { intervalMs, intervalLabel: formatLoopInterval(intervalMs) };
}

export function formatLoopInterval(intervalMs: number): string {
  for (const [unit, ms] of LABEL_UNITS) {
    if (intervalMs % ms === 0) return `${intervalMs / ms}${unit}`;
  }

  return `${Math.ceil(intervalMs / MIN_LOOP_INTERVAL_MS)}m`;
}

function loopTiming(parsed: ReturnType<typeof parseLoopInterval>): { intervalMs: number; intervalLabel: string } {
  if (parsed) return parsed;
  return { intervalMs: DEFAULT_LOOP_INTERVAL_MS, intervalLabel: formatLoopInterval(DEFAULT_LOOP_INTERVAL_MS) };
}

function loopTask(input: string, tokens: string[], hasInterval: boolean): string {
  return (hasInterval ? tokens.slice(1).join(" ") : input).trim().replace(/\s+/g, " ");
}

export function parseLoopCommand(args: string): LoopCommand {
  const input = args.trim();
  if (["", "--status"].includes(input)) return { kind: "status" };
  if (input === "--clear") return { kind: "clear" };

  const tokens = input.split(/\s+/);
  const parsedInterval = parseLoopInterval(tokens[0] ?? "");
  const { intervalMs, intervalLabel } = loopTiming(parsedInterval);
  const task = loopTask(input, tokens, parsedInterval !== null);

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
