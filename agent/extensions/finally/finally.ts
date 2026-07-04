export const FINALLY_CUSTOM_TYPE = "finally-queue";
const FINALLY_SNAPSHOT_VERSION = 1;
export const FINALLY_USAGE = "Usage: /finally <message> | /finally --status | /finally --clear";

export interface FinallyQueueItem {
  id: string;
  text: string;
  queuedAt: number;
}

export interface FinallyQueueSnapshot {
  version: typeof FINALLY_SNAPSHOT_VERSION;
  queue: FinallyQueueItem[];
  updatedAt: number;
}

export type FinallyCommand =
  | { kind: "enqueue"; text: string }
  | { kind: "status" }
  | { kind: "clear" };

interface LooseCustomEntry {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeFinallyMessage(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

export function parseFinallyCommand(args: string): FinallyCommand {
  const trimmed = normalizeFinallyMessage(args);

  if (!trimmed || trimmed === "--status") {
    return { kind: "status" };
  }

  if (trimmed === "--clear") {
    return { kind: "clear" };
  }

  if (trimmed === "--") {
    throw new Error(FINALLY_USAGE);
  }

  const message = trimmed.startsWith("-- ") ? normalizeFinallyMessage(trimmed.slice(3)) : trimmed;
  if (!message) {
    throw new Error(FINALLY_USAGE);
  }

  return { kind: "enqueue", text: message };
}

function isQueueItem(value: unknown): value is FinallyQueueItem {
  if (!isObject(value)) return false;
  return typeof value.id === "string" && typeof value.text === "string" && typeof value.queuedAt === "number";
}

function cloneQueueItem(item: FinallyQueueItem): FinallyQueueItem {
  return { id: item.id, text: item.text, queuedAt: item.queuedAt };
}

export function snapshotQueue(queue: readonly FinallyQueueItem[], updatedAt: number): FinallyQueueSnapshot {
  return {
    version: FINALLY_SNAPSHOT_VERSION,
    queue: queue.map(cloneQueueItem),
    updatedAt,
  };
}

function snapshotFromData(data: unknown): FinallyQueueSnapshot | null {
  if (!isObject(data)) return null;
  if (data.version !== FINALLY_SNAPSHOT_VERSION) return null;
  if (!Array.isArray(data.queue)) return null;

  const queue = data.queue.filter(isQueueItem).map(cloneQueueItem);
  const updatedAt = typeof data.updatedAt === "number" ? data.updatedAt : 0;
  return { version: FINALLY_SNAPSHOT_VERSION, queue, updatedAt };
}

export function reconstructFinallyQueue(entries: readonly unknown[]): FinallyQueueItem[] {
  let queue: FinallyQueueItem[] = [];

  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const candidate = entry as LooseCustomEntry;
    if (candidate.type !== "custom" || candidate.customType !== FINALLY_CUSTOM_TYPE) continue;

    const snapshot = snapshotFromData(candidate.data);
    if (snapshot) queue = snapshot.queue;
  }

  return queue;
}

export function makeFinallyQueueItem(text: string, id: string, queuedAt: number): FinallyQueueItem {
  const normalized = normalizeFinallyMessage(text);
  if (!normalized) {
    throw new Error(FINALLY_USAGE);
  }

  return { id, text: normalized, queuedAt };
}

export function enqueueFinallyMessage(
  queue: readonly FinallyQueueItem[],
  text: string,
  id: string,
  queuedAt: number,
): FinallyQueueItem[] {
  return [...queue.map(cloneQueueItem), makeFinallyQueueItem(text, id, queuedAt)];
}

export interface FinallyDequeueResult {
  item: FinallyQueueItem | null;
  queue: FinallyQueueItem[];
}

export function dequeueFinallyMessage(queue: readonly FinallyQueueItem[]): FinallyDequeueResult {
  if (queue.length === 0) return { item: null, queue: [] };
  const [item, ...rest] = queue;
  return { item: cloneQueueItem(item), queue: rest.map(cloneQueueItem) };
}

export function clearFinallyQueue(): FinallyQueueItem[] {
  return [];
}

export function previewFinallyMessage(text: string, maxLength = 80): string {
  const singleLine = normalizeFinallyMessage(text).replace(/\s+/g, " ");
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatFinallyStatus(queue: readonly FinallyQueueItem[]): string {
  if (queue.length === 0) return "No finally messages pending.";
  const noun = queue.length === 1 ? "message" : "messages";
  return `${queue.length} finally ${noun} pending. Next: ${previewFinallyMessage(queue[0].text)}`;
}

export function formatFinallyQueued(queue: readonly FinallyQueueItem[]): string {
  const noun = queue.length === 1 ? "message" : "messages";
  return `Finally queued (${queue.length} ${noun} pending).`;
}

export function formatFinallyCleared(count: number): string {
  const noun = count === 1 ? "message" : "messages";
  return count === 0 ? "No finally messages were pending." : `Cleared ${count} finally ${noun}.`;
}

export function formatFinallyStatusKey(queue: readonly FinallyQueueItem[]): string | undefined {
  return queue.length === 0 ? undefined : `finally:${queue.length}`;
}
