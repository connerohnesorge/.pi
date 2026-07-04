import {
  formatDuration,
  formatTokenValue,
  statusLabel,
  truncateText,
} from "./goal-core.ts";
import {
  latestAuditorResultForGoal,
  latestEventsForGoal,
  reconstructGoalLedger,
  type GoalLedgerEvent,
} from "./goal-ledger.ts";
import { type GoalRecord } from "./goal-record.ts";

type TerminalGoalState = ReturnType<typeof reconstructGoalLedger>["terminalGoals"] extends Map<string, infer State> ? State : never;

function appendUsageLines(lines: string[], goal: GoalRecord): void {
  if (goal.usage.tokensUsed > 0) lines.push(`  Usage: ${formatTokenValue(goal.usage.tokensUsed)}`);
  if (goal.usage.activeSeconds > 0) lines.push(`  Time: ${formatDuration(goal.usage.activeSeconds)}`);
}

type CompactEventWithLine = Exclude<GoalLedgerEvent, { type: "goal_created" | "goal_focused" | "goal_unfocused" | "audit_started" | "audit_skipped" }>;
type CompactEventLineBuilder<T extends CompactEventWithLine = CompactEventWithLine> = (event: T) => string;

const compactEventLines: { [K in CompactEventWithLine["type"]]: CompactEventLineBuilder<Extract<CompactEventWithLine, { type: K }>> } = {
  goal_paused: (event) => `    - paused: ${event.reason}`,
  goal_resumed: (event) => `    - resumed: ${event.reason}`,
  goal_tweaked: (event) => `    - tweaked: ${event.changeSummary}`,
  completion_requested: (event) => `    - completion requested${event.summary ? `: ${truncateText(event.summary, 80)}` : ""}`,
  audit_result: (event) => `    - auditor ${event.verdict}${event.verdict === "disapproved" ? `: ${truncateText(event.report, 80)}` : ""}`,
  goal_completed: () => "    - completed",
  goal_aborted: (event) => `    - aborted: ${event.reason}`,
};

function compactEventLine(event: GoalLedgerEvent): string | null {
  return event.type in compactEventLines ? compactEventLines[event.type as CompactEventWithLine["type"]](event as never) : null;
}

function appendRecentEvents(lines: string[], events: GoalLedgerEvent[], goalId: string): void {
  const eventLines = latestEventsForGoal(events, goalId, 5).map(compactEventLine).filter((line): line is string => !!line);
  if (eventLines.length === 0) return;
  lines.push("  Recent events:", ...eventLines);
}

function appendAuditorRejection(lines: string[], events: GoalLedgerEvent[], goalId: string): void {
  const auditor = latestAuditorResultForGoal(events, goalId);
  if (auditor?.verdict === "disapproved") lines.push(`  Auditor rejection (latest): ${truncateText(auditor.report, 120)}`);
}

function appendPauseLines(lines: string[], goal: GoalRecord): void {
  if (goal.pauseReason) lines.push(`  Pause reason: ${goal.pauseReason}`);
  if (goal.pauseSuggestedAction) lines.push(`  Suggested action: ${goal.pauseSuggestedAction}`);
}

export function buildGoalCompactSummary(goal: GoalRecord, events: GoalLedgerEvent[]): string {
  const lines: string[] = [];
  lines.push(`Goal ${goal.id} — ${statusLabel(goal)}`);
  lines.push(`  Objective: ${truncateText(goal.objective, 200)}`);
  appendUsageLines(lines, goal);
  appendRecentEvents(lines, events, goal.id);
  appendAuditorRejection(lines, events, goal.id);
  appendPauseLines(lines, goal);
  return lines.join("\n");
}

function appendFocusedGoal(lines: string[], goalsById: Map<string, GoalRecord>, ledgerEvents: GoalLedgerEvent[], focusedGoalId: string | null, capEventsPerGoal: number): void {
  if (!focusedGoalId || !goalsById.has(focusedGoalId)) return;
  lines.push("[FOCUSED GOAL]");
  lines.push(buildGoalCompactSummary(goalsById.get(focusedGoalId)!, latestEventsForGoal(ledgerEvents, focusedGoalId, capEventsPerGoal)));
  lines.push("");
}

function appendOtherOpenGoals(lines: string[], openGoals: GoalRecord[], focusedGoalId: string | null, capOpenGoals: number): void {
  const otherOpen = openGoals.filter((g) => g.id !== focusedGoalId);
  if (otherOpen.length === 0) return;
  lines.push(`[OTHER OPEN GOALS — ${otherOpen.length} total]`);
  for (const goal of otherOpen.slice(0, capOpenGoals)) lines.push(`- ${goal.id} — ${statusLabel(goal)} — ${truncateText(goal.objective, 120)}`);
  if (otherOpen.length > capOpenGoals) lines.push(`... and ${otherOpen.length - capOpenGoals} more`);
  lines.push("");
}

function terminalGoalLine(goalId: string, state: TerminalGoalState): string {
  const label = state.latestStatus === "complete" ? "completed" : "aborted";
  return `- ${goalId} — ${label}${state.completedAt ? ` at ${state.completedAt}` : ""}${state.abortedAt ? ` at ${state.abortedAt}` : ""}`;
}

function appendTerminalGoals(lines: string[], terminalGoals: Map<string, TerminalGoalState>): void {
  if (terminalGoals.size === 0) return;
  lines.push(`[TERMINAL GOALS — ${terminalGoals.size} completed or aborted]`);
  for (const [goalId, state] of terminalGoals) lines.push(terminalGoalLine(goalId, state));
  lines.push("");
}

function appendEmptyState(lines: string[], openGoals: GoalRecord[], terminalGoals: Map<string, TerminalGoalState>): void {
  if (openGoals.length > 0 || terminalGoals.size > 0) return;
  lines.push("[NO GOALS]");
  lines.push("No open or terminal goals recorded in this session.");
}

export function buildCompactionSummary(args: {
  goalsById: Map<string, GoalRecord>;
  focusedGoalId: string | null;
  ledgerEvents: GoalLedgerEvent[];
  capOpenGoals?: number;
  capEventsPerGoal?: number;
}): string {
  const { goalsById, focusedGoalId, ledgerEvents, capOpenGoals = 20, capEventsPerGoal = 5 } = args;
  const lines: string[] = [];
  const openGoals = Array.from(goalsById.values()).filter((g) => g.status !== "complete");
  const terminalGoals = reconstructGoalLedger(ledgerEvents).terminalGoals;

  appendFocusedGoal(lines, goalsById, ledgerEvents, focusedGoalId, capEventsPerGoal);
  appendOtherOpenGoals(lines, openGoals, focusedGoalId, capOpenGoals);
  appendTerminalGoals(lines, terminalGoals);
  appendEmptyState(lines, openGoals, terminalGoals);

  lines.push("[INSTRUCTION]");
  lines.push("Continue from the focused goal above, or ask the user to run /goalie, /goalie-set, or /goalie-focus.");
  lines.push("Do not rely on chat memory for goal state; use the facts above.");

  return lines.join("\n");
}
