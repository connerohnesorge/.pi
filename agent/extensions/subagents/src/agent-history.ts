export type AgentHistoryRole = "user" | "assistant" | "tool";

export type AgentHistoryKind = "text" | "toolCall" | "toolResult" | "error";

export interface AgentHistoryEntry {
  role: AgentHistoryRole;
  kind: AgentHistoryKind;
  text: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
}

export interface AgentHistoryOptions {
  maxEntries?: number;
  maxTextChars?: number;
  maxTotalChars?: number;
}

const DEFAULT_MAX_ENTRIES = 40;
const DEFAULT_MAX_TEXT_CHARS = 2000;
const DEFAULT_MAX_TOTAL_CHARS = 20000;

export function compactAgentHistory(messages: unknown[], options: AgentHistoryOptions = {}): AgentHistoryEntry[] {
  const entries = messages.flatMap(entriesFromMessage);
  return fitEntries(
    entries,
    positiveInt(options.maxEntries, DEFAULT_MAX_ENTRIES),
    positiveInt(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS),
    positiveInt(options.maxTotalChars, DEFAULT_MAX_TOTAL_CHARS),
  );
}

function entriesFromMessage(raw: unknown): AgentHistoryEntry[] {
  const message = asRecord(raw);
  if (!message) return [];

  const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;
  if (message.role === "user") return userEntries(message, timestamp);
  if (message.role === "assistant") return assistantEntries(message, timestamp);
  if (message.role === "toolResult") return toolResultEntries(message, timestamp);
  return [];
}

function userEntries(message: Record<string, unknown>, timestamp?: number): AgentHistoryEntry[] {
  const text = textFromContent(message.content);
  return text.trim() ? [{ role: "user", kind: "text", text, timestamp }] : [];
}

function assistantEntries(message: Record<string, unknown>, timestamp?: number): AgentHistoryEntry[] {
  const entries = assistantContentEntries(message.content, timestamp);
  if (typeof message.errorMessage === "string" && message.errorMessage.trim()) {
    entries.push({ role: "assistant", kind: "error", text: message.errorMessage, isError: true, timestamp });
  }
  return entries;
}

function assistantContentEntries(content: unknown, timestamp?: number): AgentHistoryEntry[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part): AgentHistoryEntry[] => {
    const block = asRecord(part);
    if (!block || typeof block.type !== "string") return [];
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      return [{ role: "assistant", kind: "text", text: block.text, timestamp }];
    }
    if (block.type === "toolCall" && typeof block.name === "string") {
      return [{ role: "assistant", kind: "toolCall", toolName: block.name, text: stringifyCompact(block.arguments ?? {}), timestamp }];
    }
    return [];
  });
}

function toolResultEntries(message: Record<string, unknown>, timestamp?: number): AgentHistoryEntry[] {
  return [
    {
      role: "tool",
      kind: message.isError ? "error" : "toolResult",
      toolName: typeof message.toolName === "string" ? message.toolName : undefined,
      text: textFromContent(message.content) || "(no text output)",
      isError: Boolean(message.isError),
      timestamp,
    },
  ];
}

function fitEntries(
  entries: AgentHistoryEntry[],
  maxEntries: number,
  maxTextChars: number,
  maxTotalChars: number,
): AgentHistoryEntry[] {
  const fitted: AgentHistoryEntry[] = [];
  let total = 0;

  for (const entry of entries.slice(-maxEntries).reverse()) {
    const remaining = maxTotalChars - total;
    if (remaining <= 0) break;
    const text = truncateText(entry.text, Math.min(maxTextChars, remaining));
    fitted.unshift({ ...entry, text });
    total += text.length;
  }

  return fitted;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = asRecord(part);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("");
}

function stringifyCompact(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 20) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 20)}... [truncated]`;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
