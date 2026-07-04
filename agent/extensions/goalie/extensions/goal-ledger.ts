import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeRelPath, nowIso, safeIdPart, type GoalRecord } from "./goal-record.ts";

const GOAL_LEDGER_FILE = ".pi/goals/goal_events.jsonl";

export type GoalLedgerEvent =
  | { type: "goal_created"; goalId: string; objective: string; sisyphus: boolean; autoContinue: boolean; at: string }
  | { type: "goal_focused"; goalId: string; reason: string; at: string }
  | { type: "goal_unfocused"; reason: string; at: string }
  | { type: "goal_paused"; goalId: string; reason: string; suggestedAction?: string; status?: "paused"; at: string }
  | { type: "goal_resumed"; goalId: string; reason: string; at: string }
  | { type: "goal_tweaked"; goalId: string; changeSummary: string; at: string }
  | { type: "completion_requested"; goalId: string; summary?: string; at: string }
  | { type: "audit_started"; goalId: string; provider?: string; model?: string; thinkingLevel?: string; at: string }
  | { type: "audit_result"; goalId: string; verdict: "approved" | "disapproved" | "error"; report: string; at: string }
  | { type: "audit_skipped"; goalId: string; reason: "disabled" | "user_aborted"; provider?: string; model?: string; thinkingLevel?: string; at: string }
  | { type: "goal_completed"; goalId: string; archivePath?: string; at: string }
  | { type: "goal_aborted"; goalId: string; reason: string; archivePath?: string; at: string };

export interface GoalLedgerContext {
  cwd: string;
}

export interface GoalLedgerReadResult {
  events: GoalLedgerEvent[];
  malformed: number;
}

interface ReconstructedGoalState {
  goalId: string;
  latestStatus: "active" | "paused" | "complete" | "aborted" | "unknown";
  latestFocus: boolean;
  latestPauseReason?: string;
  latestPauseSuggestedAction?: string;
  latestAuditorResult?: { verdict: "approved" | "disapproved" | "error"; report: string; at: string };
  createdAt?: string;
  completedAt?: string;
  abortedAt?: string;
  tweakedAt?: string;
  resumedAt?: string;
}

export interface ReconstructedLedgerState {
  focusedGoalId: string | null;
  goals: Map<string, ReconstructedGoalState>;
  terminalGoals: Map<string, ReconstructedGoalState>;
}

function safeGoalId(value: string): string {
  return safeIdPart(value);
}

export function goalLedgerPath(ctx: GoalLedgerContext): string {
  return path.resolve(ctx.cwd, normalizeRelPath(GOAL_LEDGER_FILE));
}

export function appendGoalEvent(ctx: GoalLedgerContext, event: GoalLedgerEvent): void {
  const filePath = goalLedgerPath(ctx);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const line = JSON.stringify(event) + "\n";
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let appended = false;
  try {
    fs.writeFileSync(tempPath, line, { flag: "wx", encoding: "utf8" });
    fs.appendFileSync(filePath, fs.readFileSync(tempPath, "utf8"), "utf8");
    appended = true;
  } catch {
    // If temp write fails, try direct append as fallback.
    // Skip fallback only if the primary append already succeeded.
    if (!appended) {
      try {
        fs.appendFileSync(filePath, line, "utf8");
        appended = true;
      } catch {
        // Ledger append failure should not crash the transaction.
        // Callers that need strict durability can check the return.
      }
    }
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Temp file may not exist; ignore cleanup failure.
    }
  }
}

export function readGoalLedger(ctx: GoalLedgerContext): GoalLedgerReadResult {
  const filePath = goalLedgerPath(ctx);
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return { events: [], malformed: 0 };
  }

  const events: GoalLedgerEvent[] = [];
  let malformed = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isValidLedgerEvent(parsed)) {
        events.push(sanitizeEvent(parsed));
      } else {
        malformed++;
      }
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

type LedgerEventValidator = (obj: Record<string, unknown>) => boolean;

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function hasGoalId(obj: Record<string, unknown>): boolean {
  return isString(obj.goalId);
}

function hasGoalIdAndReason(obj: Record<string, unknown>): boolean {
  return hasGoalId(obj) && isString(obj.reason);
}

const ledgerEventValidators: Record<GoalLedgerEvent["type"], LedgerEventValidator> = {
  goal_created: (obj) => hasGoalId(obj) && isString(obj.objective) && typeof obj.sisyphus === "boolean" && typeof obj.autoContinue === "boolean",
  goal_focused: hasGoalIdAndReason,
  goal_unfocused: (obj) => isString(obj.reason),
  goal_paused: (obj) => hasGoalIdAndReason(obj) && isOptionalString(obj.suggestedAction) && (obj.status === undefined || obj.status === "paused"),
  goal_resumed: hasGoalIdAndReason,
  goal_tweaked: (obj) => hasGoalId(obj) && isString(obj.changeSummary),
  completion_requested: (obj) => hasGoalId(obj) && isOptionalString(obj.summary),
  audit_started: (obj) => hasGoalId(obj) && isOptionalString(obj.provider) && isOptionalString(obj.model) && isOptionalString(obj.thinkingLevel),
  audit_result: (obj) => hasGoalId(obj) && (obj.verdict === "approved" || obj.verdict === "disapproved" || obj.verdict === "error") && isString(obj.report),
  audit_skipped: (obj) => hasGoalId(obj) && (obj.reason === "disabled" || obj.reason === "user_aborted") && isOptionalString(obj.provider) && isOptionalString(obj.model) && isOptionalString(obj.thinkingLevel),
  goal_completed: (obj) => hasGoalId(obj) && isOptionalString(obj.archivePath),
  goal_aborted: (obj) => hasGoalIdAndReason(obj) && isOptionalString(obj.archivePath),
};

function isValidLedgerEvent(value: unknown): value is GoalLedgerEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.type !== "string" || typeof obj.at !== "string") return false;
  return ledgerEventValidators[obj.type as GoalLedgerEvent["type"]]?.(obj) ?? false;
}

function sanitizeEvent(event: GoalLedgerEvent): GoalLedgerEvent {
  return "goalId" in event ? { ...event, goalId: safeGoalId(event.goalId) } : event;
}

function clearGoalFocus(goals: Map<string, ReconstructedGoalState>, terminalGoals: Map<string, ReconstructedGoalState>): void {
  for (const g of goals.values()) g.latestFocus = false;
  for (const g of terminalGoals.values()) g.latestFocus = false;
}

function moveGoalToTerminal(goals: Map<string, ReconstructedGoalState>, terminalGoals: Map<string, ReconstructedGoalState>, goalId: string, status: "complete" | "aborted", at: string): void {
  const state = goals.get(goalId) ?? { goalId, latestStatus: status, latestFocus: false };
  state.latestStatus = status;
  if (status === "complete") state.completedAt = at;
  else state.abortedAt = at;
  terminalGoals.set(goalId, state);
  goals.delete(goalId);
}

type LedgerMutation = {
  goals: Map<string, ReconstructedGoalState>;
  terminalGoals: Map<string, ReconstructedGoalState>;
  focusedGoalId: string | null;
};

type LedgerEventHandler<T extends GoalLedgerEvent = GoalLedgerEvent> = (state: LedgerMutation, event: T) => void;

function createdState(event: Extract<GoalLedgerEvent, { type: "goal_created" }>): ReconstructedGoalState {
  return { goalId: event.goalId, latestStatus: "active", latestFocus: false, createdAt: event.at };
}

function currentGoal(state: LedgerMutation, goalId: string): ReconstructedGoalState | undefined {
  return state.goals.get(goalId) ?? state.terminalGoals.get(goalId);
}

function handleGoalCreated(state: LedgerMutation, event: Extract<GoalLedgerEvent, { type: "goal_created" }>): void {
  state.goals.set(event.goalId, createdState(event));
}

function handleGoalFocused(state: LedgerMutation, event: Extract<GoalLedgerEvent, { type: "goal_focused" }>): void {
  state.focusedGoalId = event.goalId;
  clearGoalFocus(state.goals, state.terminalGoals);
  const goal = currentGoal(state, event.goalId);
  if (goal) goal.latestFocus = true;
}

function handleGoalUnfocused(state: LedgerMutation): void {
  state.focusedGoalId = null;
  clearGoalFocus(state.goals, state.terminalGoals);
}

function handleGoalPaused(state: LedgerMutation, event: Extract<GoalLedgerEvent, { type: "goal_paused" }>): void {
  const goal = state.goals.get(event.goalId);
  if (!goal) return;
  goal.latestStatus = event.status ?? "paused";
  goal.latestPauseReason = event.reason;
  goal.latestPauseSuggestedAction = event.suggestedAction;
}

function handleGoalResumed(state: LedgerMutation, event: Extract<GoalLedgerEvent, { type: "goal_resumed" }>): void {
  const goal = state.goals.get(event.goalId);
  if (!goal) return;
  goal.latestStatus = "active";
  goal.resumedAt = event.at;
  delete goal.latestPauseReason;
  delete goal.latestPauseSuggestedAction;
}

function handleGoalTweaked(state: LedgerMutation, event: Extract<GoalLedgerEvent, { type: "goal_tweaked" }>): void {
  const goal = state.goals.get(event.goalId);
  if (goal) goal.tweakedAt = event.at;
}

function handleAuditResult(state: LedgerMutation, event: Extract<GoalLedgerEvent, { type: "audit_result" }>): void {
  const goal = currentGoal(state, event.goalId);
  if (goal) goal.latestAuditorResult = { verdict: event.verdict, report: event.report, at: event.at };
}

function handleGoalCompleted(state: LedgerMutation, event: Extract<GoalLedgerEvent, { type: "goal_completed" }>): void {
  moveGoalToTerminal(state.goals, state.terminalGoals, event.goalId, "complete", event.at);
}

function handleGoalAborted(state: LedgerMutation, event: Extract<GoalLedgerEvent, { type: "goal_aborted" }>): void {
  moveGoalToTerminal(state.goals, state.terminalGoals, event.goalId, "aborted", event.at);
}

const ledgerEventHandlers: { [K in GoalLedgerEvent["type"]]?: LedgerEventHandler<Extract<GoalLedgerEvent, { type: K }>> } = {
  goal_created: handleGoalCreated,
  goal_focused: handleGoalFocused,
  goal_unfocused: handleGoalUnfocused,
  goal_paused: handleGoalPaused,
  goal_resumed: handleGoalResumed,
  goal_tweaked: handleGoalTweaked,
  audit_result: handleAuditResult,
  goal_completed: handleGoalCompleted,
  goal_aborted: handleGoalAborted,
};

function applyLedgerEvent(state: LedgerMutation, event: GoalLedgerEvent): void {
  ledgerEventHandlers[event.type]?.(state, event as never);
}

export function reconstructGoalLedger(events: GoalLedgerEvent[]): ReconstructedLedgerState {
  const state: LedgerMutation = {
    goals: new Map<string, ReconstructedGoalState>(),
    terminalGoals: new Map<string, ReconstructedGoalState>(),
    focusedGoalId: null,
  };

  for (const event of events) applyLedgerEvent(state, event);

  // If the focused goal was moved to terminal (e.g., aborted/completed), clear focus.
  if (state.focusedGoalId && !state.goals.has(state.focusedGoalId)) {
    state.focusedGoalId = null;
  }

  return { focusedGoalId: state.focusedGoalId, goals: state.goals, terminalGoals: state.terminalGoals };
}

export function latestAuditorResultForGoal(events: GoalLedgerEvent[], goalId: string): { verdict: "approved" | "disapproved" | "error"; report: string; at: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === "audit_result" && event.goalId === goalId) {
      return { verdict: event.verdict, report: event.report, at: event.at };
    }
  }
  return undefined;
}

export function latestEventsForGoal(events: GoalLedgerEvent[], goalId: string, limit = 10): GoalLedgerEvent[] {
  const result: GoalLedgerEvent[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if ("goalId" in event && event.goalId === goalId) {
      result.unshift(event);
      if (result.length >= limit) break;
    }
  }
  return result;
}

export function latestGoalLifecycleEvent(events: GoalLedgerEvent[], goalId: string): GoalLedgerEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if ("goalId" in event && event.goalId === goalId) {
      return event;
    }
  }
  return undefined;
}
