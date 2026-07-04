export const DEFAULT_HISTORY_LIMIT = 500;

export type PromptHistorySource = "saved" | "current";

export interface PromptSourceInfo {
	source: PromptHistorySource;
	sessionPath?: string;
	cwd?: string;
	sessionName?: string;
	modifiedMs?: number;
}

export interface PromptHistoryItem {
	id: string;
	text: string;
	normalizedText: string;
	preview: string;
	timestampMs: number;
	source: PromptHistorySource;
	sessionPath?: string;
	cwd?: string;
	sessionName?: string;
	entryId?: string;
}

interface LooseTextBlock {
	type?: unknown;
	text?: unknown;
}

interface LooseEntry {
	type?: unknown;
	id?: unknown;
	timestamp?: unknown;
	message?: {
		role?: unknown;
		content?: unknown;
		timestamp?: unknown;
	};
}

export function normalizePromptText(text: string): string {
	return text.replace(/\r\n?/g, "\n").trim();
}

export function normalizeSearchText(text: string): string {
	return normalizePromptText(text).replace(/\s+/g, " ").toLowerCase();
}

export function formatPromptPreview(text: string, maxLength = 120): string {
	const singleLine = normalizePromptText(text).replace(/\s+/g, " ");
	if (singleLine.length <= maxLength) return singleLine;
	return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function extractPromptTextFromMessageContent(content: unknown): string | null {
	if (typeof content === "string") {
		const normalized = normalizePromptText(content);
		return normalized ? normalized : null;
	}

	if (!Array.isArray(content)) return null;

	const text = content
		.filter((block): block is LooseTextBlock => {
			return Boolean(block) && typeof block === "object" && (block as LooseTextBlock).type === "text";
		})
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.join("\n");

	const normalized = normalizePromptText(text);
	return normalized ? normalized : null;
}

function timestampToMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function sourceKey(source: PromptSourceInfo): string {
	return source.sessionPath ?? source.cwd ?? source.sessionName ?? source.source;
}

function userMessageEntry(entry: unknown): LooseEntry | null {
	if (!entry || typeof entry !== "object") return null;
	const candidate = entry as LooseEntry;
	return candidate.type === "message" && candidate.message?.role === "user" ? candidate : null;
}

function buildPromptItem(candidate: LooseEntry, source: PromptSourceInfo, ordinal: number, text: string): PromptHistoryItem | null {
	const normalizedText = normalizeSearchText(text);
	if (!normalizedText) return null;

	const timestampMs = timestampToMs(candidate.message?.timestamp) ?? timestampToMs(candidate.timestamp) ?? source.modifiedMs ?? 0;
	const entryId = typeof candidate.id === "string" ? candidate.id : `line-${ordinal}`;

	return {
		id: `${source.source}:${sourceKey(source)}:${entryId}:${ordinal}`,
		text,
		normalizedText,
		preview: formatPromptPreview(text),
		timestampMs,
		source: source.source,
		sessionPath: source.sessionPath,
		cwd: source.cwd,
		sessionName: source.sessionName,
		entryId,
	};
}

function promptFromSessionEntry(entry: unknown, source: PromptSourceInfo, ordinal = 0): PromptHistoryItem | null {
	const candidate = userMessageEntry(entry);
	if (!candidate) return null;

	const text = extractPromptTextFromMessageContent(candidate.message?.content);
	return text ? buildPromptItem(candidate, source, ordinal, text) : null;
}

export function extractPromptsFromEntries(entries: unknown[], source: PromptSourceInfo): PromptHistoryItem[] {
	const prompts: PromptHistoryItem[] = [];
	entries.forEach((entry, index) => {
		const prompt = promptFromSessionEntry(entry, source, index);
		if (prompt) prompts.push(prompt);
	});
	return prompts;
}

export function extractPromptsFromSessionJsonl(content: string, source: PromptSourceInfo): PromptHistoryItem[] {
	const prompts: PromptHistoryItem[] = [];
	const lines = content.split(/\r?\n/);

	lines.forEach((line, index) => {
		if (!line.trim()) return;
		try {
			const entry = JSON.parse(line) as unknown;
			const prompt = promptFromSessionEntry(entry, source, index);
			if (prompt) prompts.push(prompt);
		} catch {
			// Ignore malformed session lines; one bad line should not break history search.
		}
	});

	return prompts;
}

function rankPromptHistory(prompts: PromptHistoryItem[], limit = DEFAULT_HISTORY_LIMIT): PromptHistoryItem[] {
	const newestFirst = [...prompts].sort((a, b) => b.timestampMs - a.timestampMs);
	const seen = new Set<string>();
	const result: PromptHistoryItem[] = [];

	for (const prompt of newestFirst) {
		if (seen.has(prompt.normalizedText)) continue;
		seen.add(prompt.normalizedText);
		result.push(prompt);
		if (result.length >= limit) break;
	}

	return result;
}

export function filterPromptHistory(prompts: PromptHistoryItem[], query: string): PromptHistoryItem[] {
	const tokens = normalizeSearchText(query).split(" ").filter(Boolean);
	if (tokens.length === 0) return prompts;

	return prompts.filter((prompt) => {
		const haystack = normalizeSearchText(`${prompt.text}\n${prompt.cwd ?? ""}\n${prompt.sessionName ?? ""}`);
		return tokens.every((token) => haystack.includes(token));
	});
}

export function buildPromptHistory(prompts: PromptHistoryItem[], limit = DEFAULT_HISTORY_LIMIT): PromptHistoryItem[] {
	return rankPromptHistory(
		prompts.filter((prompt) => prompt.normalizedText.length > 0),
		limit,
	);
}
