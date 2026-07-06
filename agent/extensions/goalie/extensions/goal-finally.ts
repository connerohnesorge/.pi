export const GOAL_FINALLY_CUSTOM_TYPE = "pi-goal-finally";
const GOAL_FINALLY_SNAPSHOT_VERSION = 1;
export const GOAL_FINALLY_USAGE = "Usage: /finally-goalie <prompt-or-command> | /finally-goalie --status | /finally-goalie --clear";

export interface GoalFinallyItem {
	id: string;
	goalId: string;
	text: string;
	queuedAt: number;
}

export interface GoalFinallySnapshot {
	version: typeof GOAL_FINALLY_SNAPSHOT_VERSION;
	items: GoalFinallyItem[];
	updatedAt: number;
}

export type GoalFinallyCommand =
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

function normalizeGoalFinallyText(text: string): string {
	return text.replace(/\r\n?/g, "\n").trim();
}

export function parseGoalFinallyCommand(args: string): GoalFinallyCommand {
	const trimmed = normalizeGoalFinallyText(args);
	if (!trimmed || trimmed === "--status") return { kind: "status" };
	if (trimmed === "--clear") return { kind: "clear" };
	if (trimmed === "--") throw new Error(GOAL_FINALLY_USAGE);

	const text = trimmed.startsWith("-- ") ? normalizeGoalFinallyText(trimmed.slice(3)) : trimmed;
	if (!text) throw new Error(GOAL_FINALLY_USAGE);
	return { kind: "enqueue", text };
}

function isGoalFinallyItem(value: unknown): value is GoalFinallyItem {
	if (!isObject(value)) return false;
	return typeof value.id === "string"
		&& typeof value.goalId === "string"
		&& typeof value.text === "string"
		&& typeof value.queuedAt === "number";
}

function cloneGoalFinallyItem(item: GoalFinallyItem): GoalFinallyItem {
	return { id: item.id, goalId: item.goalId, text: item.text, queuedAt: item.queuedAt };
}

function dedupeByGoal(items: readonly GoalFinallyItem[]): GoalFinallyItem[] {
	const byGoal = new Map<string, GoalFinallyItem>();
	for (const item of items) byGoal.set(item.goalId, cloneGoalFinallyItem(item));
	return [...byGoal.values()];
}

export function snapshotGoalFinallyItems(items: readonly GoalFinallyItem[], updatedAt: number): GoalFinallySnapshot {
	return {
		version: GOAL_FINALLY_SNAPSHOT_VERSION,
		items: dedupeByGoal(items),
		updatedAt,
	};
}

function snapshotFromData(data: unknown): GoalFinallySnapshot | null {
	if (!isObject(data)) return null;
	if (data.version !== GOAL_FINALLY_SNAPSHOT_VERSION) return null;
	if (!Array.isArray(data.items)) return null;

	const items = dedupeByGoal(data.items.filter(isGoalFinallyItem));
	const updatedAt = typeof data.updatedAt === "number" ? data.updatedAt : 0;
	return { version: GOAL_FINALLY_SNAPSHOT_VERSION, items, updatedAt };
}

export function reconstructGoalFinallyItems(entries: readonly unknown[]): GoalFinallyItem[] {
	let items: GoalFinallyItem[] = [];
	for (const entry of entries) {
		if (!isObject(entry)) continue;
		const candidate = entry as LooseCustomEntry;
		if (candidate.type !== "custom" || candidate.customType !== GOAL_FINALLY_CUSTOM_TYPE) continue;
		const snapshot = snapshotFromData(candidate.data);
		if (snapshot) items = snapshot.items;
	}
	return items;
}

export function makeGoalFinallyItem(goalId: string, text: string, id: string, queuedAt: number): GoalFinallyItem {
	const normalized = normalizeGoalFinallyText(text);
	if (!goalId || !normalized) throw new Error(GOAL_FINALLY_USAGE);
	return { id, goalId, text: normalized, queuedAt };
}

export function replaceGoalFinallyItem(
	items: readonly GoalFinallyItem[],
	goalId: string,
	text: string,
	id: string,
	queuedAt: number,
): GoalFinallyItem[] {
	return [
		...items.filter((item) => item.goalId !== goalId).map(cloneGoalFinallyItem),
		makeGoalFinallyItem(goalId, text, id, queuedAt),
	];
}

export interface GoalFinallyDequeueResult {
	item: GoalFinallyItem | null;
	items: GoalFinallyItem[];
}

export function dequeueGoalFinallyItem(items: readonly GoalFinallyItem[], goalId: string): GoalFinallyDequeueResult {
	const item = [...items].reverse().find((candidate) => candidate.goalId === goalId) ?? null;
	return {
		item: item ? cloneGoalFinallyItem(item) : null,
		items: items.filter((candidate) => candidate.goalId !== goalId).map(cloneGoalFinallyItem),
	};
}

export function clearGoalFinallyItems(items: readonly GoalFinallyItem[], goalId?: string): GoalFinallyItem[] {
	return goalId === undefined ? [] : items.filter((item) => item.goalId !== goalId).map(cloneGoalFinallyItem);
}

export function previewGoalFinallyText(text: string, maxLength = 80): string {
	const singleLine = normalizeGoalFinallyText(text).replace(/\s+/g, " ");
	if (singleLine.length <= maxLength) return singleLine;
	return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatGoalFinallyQueued(item: GoalFinallyItem): string {
	return `Goalie final command queued: ${previewGoalFinallyText(item.text)}`;
}

export function formatGoalFinallyStatus(items: readonly GoalFinallyItem[], focusedGoalId?: string | null): string {
	if (items.length === 0) return "No goalie final commands pending.";
	const focused = focusedGoalId ? items.find((item) => item.goalId === focusedGoalId) : undefined;
	if (focused) return `Focused goal final command: ${previewGoalFinallyText(focused.text)}`;
	const noun = items.length === 1 ? "command" : "commands";
	return `${items.length} goalie final ${noun} pending.`;
}

export function formatGoalFinallyCleared(count: number): string {
	const noun = count === 1 ? "command" : "commands";
	return count === 0 ? "No goalie final commands were pending." : `Cleared ${count} goalie final ${noun}.`;
}

export function goalFinallyStatusKey(items: readonly GoalFinallyItem[]): string | undefined {
	return items.length === 0 ? undefined : `finally-goalie:${items.length}`;
}
