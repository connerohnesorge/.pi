export type GoalStatus = "active" | "paused" | "complete";
export type StopReason = "user" | "agent";
export type GoalEventKind = "checkpoint" | "stale" | "drafting";
export type DraftingFocus = "goal" | "sisyphus";
export type GoalFocusReason = "created" | "selected" | "resumed" | "completed" | "cleared" | "aborted" | "migrated";

interface GoalUsage {
	tokensUsed: number;
	activeSeconds: number;
}

export interface GoalRecord {
	id: string;
	objective: string;
	status: GoalStatus;
	autoContinue: boolean;
	usage: GoalUsage;
	sisyphus: boolean;
	createdAt: string;
	updatedAt: string;
	activePath?: string;
	archivedPath?: string;
	stopReason?: StopReason;
	// Set by the agent's pause_goal tool. Cleared when the goal becomes active again.
	pauseReason?: string;
	pauseSuggestedAction?: string;
}

export interface GoalStateEntry {
	version: 3;
	goal: GoalRecord | null;
}

export interface GoalFocusEntry {
	version: 1;
	focusedGoalId: string | null;
	reason: GoalFocusReason;
}

export interface GoalEventDetails {
	kind: GoalEventKind;
	goalId: string;
	status?: GoalStatus;
	objective?: string;
	timestamp?: number;
	currentGoalId?: string | null;
	currentStatus?: GoalStatus | null;
	focus?: DraftingFocus;
}

export interface GoalCreationConfig {
	objective: string;
	autoContinue: boolean;
	sisyphus: boolean;
}

interface AssistantUsage {
	input?: number;
	output?: number;
}

export interface AssistantMessageLike {
	role?: string;
	stopReason?: string;
	usage?: AssistantUsage;
}

export function nowIso(now = Date.now()): string {
	return new Date(now).toISOString();
}

export function safeIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "goal";
}

function newGoalId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeRelPath(relPath: string): string {
	return relPath.split(/[\\/]+/).join("/");
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function emptyUsage(): GoalUsage {
	return { tokensUsed: 0, activeSeconds: 0 };
}

export function cloneGoal(goal: GoalRecord): GoalRecord {
	return { ...goal, usage: { ...goal.usage } };
}

export function goalFocusDetails(focusedGoalId: string | null, reason: GoalFocusReason): GoalFocusEntry {
	return {
		version: 1,
		focusedGoalId: focusedGoalId ? safeIdPart(focusedGoalId) : null,
		reason,
	};
}

const goalFocusReasons = new Set<GoalFocusReason>(["created", "selected", "resumed", "completed", "cleared", "aborted", "migrated"]);

function normalizeFocusedGoalId(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? safeIdPart(value) : null;
}

function normalizeGoalFocusReason(value: unknown): GoalFocusReason {
	return typeof value === "string" && goalFocusReasons.has(value as GoalFocusReason) ? (value as GoalFocusReason) : "selected";
}

export function normalizeGoalFocusEntry(value: unknown): GoalFocusEntry | null {
	const raw = asRecord(value);
	if (!raw || raw.version !== 1) return null;
	return { version: 1, focusedGoalId: normalizeFocusedGoalId(raw.focusedGoalId), reason: normalizeGoalFocusReason(raw.reason) };
}

export function createGoal(config: GoalCreationConfig, now = Date.now()): GoalRecord {
	const timestamp = nowIso(now);
	return {
		id: newGoalId(),
		objective: config.objective,
		status: "active",
		autoContinue: config.autoContinue,
		usage: emptyUsage(),
		sisyphus: config.sisyphus,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

function normalizeUsage(value: unknown): GoalUsage {
	const raw = asRecord(value);
	if (!raw) return emptyUsage();
	const tokensUsed = typeof raw.tokensUsed === "number" && Number.isFinite(raw.tokensUsed) ? Math.max(0, Math.floor(raw.tokensUsed)) : 0;
	const activeSeconds = typeof raw.activeSeconds === "number" && Number.isFinite(raw.activeSeconds) ? Math.max(0, Math.floor(raw.activeSeconds)) : 0;
	return { tokensUsed, activeSeconds };
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalTrimmedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeGoalStatus(value: unknown, autoContinue: boolean): GoalStatus {
	const status: GoalStatus = value === "complete" ? "complete" : value === "paused" ? "paused" : "active";
	return status === "paused" && autoContinue ? "active" : status;
}

function normalizeStopReason(value: unknown): StopReason | undefined {
	return value === "agent" || value === "user" ? value : undefined;
}

export function normalizeGoalRecord(value: unknown): GoalRecord | null {
	const raw = asRecord(value);
	if (!raw) return null;
	const objective = optionalTrimmedString(raw.objective);
	if (!objective) return null;

	const timestamp = nowIso();
	const autoContinue = typeof raw.autoContinue === "boolean" ? raw.autoContinue : true;
	return {
		id: typeof raw.id === "string" && raw.id ? safeIdPart(raw.id) : newGoalId(),
		objective,
		status: normalizeGoalStatus(raw.status, autoContinue),
		autoContinue,
		usage: normalizeUsage(raw.usage),
		sisyphus: raw.sisyphus === true,
		createdAt: optionalString(raw.createdAt) ?? timestamp,
		updatedAt: optionalString(raw.updatedAt) ?? timestamp,
		activePath: optionalString(raw.activePath),
		archivedPath: optionalString(raw.archivedPath),
		stopReason: normalizeStopReason(raw.stopReason),
		pauseReason: optionalTrimmedString(raw.pauseReason),
		pauseSuggestedAction: optionalTrimmedString(raw.pauseSuggestedAction),
	};
}
