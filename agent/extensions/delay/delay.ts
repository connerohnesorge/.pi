export const DELAY_USAGE = "Usage: /delay [delay] [message]";
export const DEFAULT_DELAY_MS = 10 * 60 * 1000;
export const MIN_DELAY_MS = 60 * 1000;

export type DelayCommand =
  | { kind: "start"; delayMs: number; delayLabel: string; message: string }
  | { kind: "status" }
  | { kind: "clear" };

const DELAY_PATTERN = /^(\d+)([smhd])$/i;
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

const COMMANDS: Record<string, DelayCommand> = {
  "": { kind: "status" },
  "--status": { kind: "status" },
  "--clear": { kind: "clear" },
};

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function parseDelayDuration(token: string): { delayMs: number; delayLabel: string } | null {
  const match = token.match(DELAY_PATTERN);
  if (!match) return null;

  const amount = Number.parseInt(match[1] ?? "", 10);
  const unit = (match[2] ?? "").toLowerCase();
  if (!Number.isSafeInteger(amount) || amount <= 0 || !(unit in UNIT_MS)) return null;

  const rawMs = amount * UNIT_MS[unit];
  const delayMs = Math.max(rawMs, MIN_DELAY_MS);
  return { delayMs, delayLabel: formatDelayDuration(delayMs) };
}

export function formatDelayDuration(delayMs: number): string {
  const units: Array<[string, number]> = [
    ["d", UNIT_MS.d],
    ["h", UNIT_MS.h],
    ["m", UNIT_MS.m],
  ];

  for (const [unit, ms] of units) {
    if (delayMs % ms === 0) return `${delayMs / ms}${unit}`;
  }

  return `${Math.ceil(delayMs / MIN_DELAY_MS)}m`;
}

export function parseDelayCommand(args: string): DelayCommand {
  const trimmed = args.trim();
  const command = COMMANDS[trimmed];
  if (command) return command;

  const [firstToken = "", ...rest] = trimmed.split(/\s+/);
  const parsedDelay = parseDelayDuration(firstToken);
  const delayMs = parsedDelay?.delayMs ?? DEFAULT_DELAY_MS;
  const delayLabel = parsedDelay?.delayLabel ?? formatDelayDuration(DEFAULT_DELAY_MS);
  const message = normalizeWhitespace(parsedDelay ? rest.join(" ") : trimmed);

  if (message.length === 0) throw new Error(DELAY_USAGE);

  return { kind: "start", delayMs, delayLabel, message };
}

export interface DelayJob {
  id: number;
  message: string;
  delayMs: number;
  delayLabel: string;
  createdAt: number;
  sendAt: number;
}

export function formatDelayScheduled(job: DelayJob): string {
  return `Delay #${job.id} scheduled in ${job.delayLabel}: ${job.message}`;
}

export function formatDelayStatus(jobs: readonly DelayJob[], now: number): string {
  if (jobs.length === 0) return "No delayed messages scheduled.";
  return jobs
    .map((job) => {
      const minutes = Math.max(0, Math.ceil((job.sendAt - now) / MIN_DELAY_MS));
      const suffix = minutes === 0 ? "due now" : `sends in ${minutes}m`;
      return `#${job.id} in ${job.delayLabel} (${suffix}): ${job.message}`;
    })
    .join("\n");
}

export function formatDelayCleared(count: number): string {
  return count === 0 ? "No delayed messages were scheduled." : `Cancelled ${count} delay${count === 1 ? "" : "s"}.`;
}

export function formatDelayStatusKey(jobs: readonly DelayJob[]): string | undefined {
  return jobs.length === 0 ? undefined : `delay:${jobs.length}`;
}

export function previewDelayDelivery(delayMs: number, now: number): string {
  return new Date(now + delayMs).toLocaleString();
}
