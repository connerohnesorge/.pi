import { asRecord, type GoalStatus } from "./goal-record.ts";
import {
	ACTIVE_GOAL_TOOL_NAMES,
	CREATE_GOAL_TOOL_NAME,
	GOAL_PROGRESS_TOOL_NAMES,
	POST_STOP_ALLOWED_TOOLS,
	PROPOSE_DRAFT_TOOL_NAME,
	QUESTIONNAIRE_TOOL_NAME,
	QUESTION_TOOL_NAME,
	TWEAK_APPLY_TOOL_NAME,
	lifecycleToolNamesForGoalStatus,
} from "./goal-tool-names.ts";

const GOAL_EXECUTION_WORK_TOOLS = ["read", "bash", "edit", "write"] as const;

const GOAL_PROGRESS_TOOL_SET = new Set<string>(GOAL_PROGRESS_TOOL_NAMES);
const POST_STOP_ALLOWED_TOOL_SET = new Set<string>(POST_STOP_ALLOWED_TOOLS);

function iterableToolNames(currentTools: Iterable<unknown>): string[] {
	const names: string[] = [];
	for (const entry of currentTools) {
		if (typeof entry === "string") {
			names.push(entry);
			continue;
		}
		if (Array.isArray(entry) && typeof entry[0] === "string") {
			names.push(entry[0]);
		}
	}
	return names;
}

export interface GoalActiveToolPolicyInput {
	currentTools: Iterable<unknown>;
	goalStatus?: GoalStatus | null;
	goalId?: string | null;
	confirmationActive: boolean;
	tweakDraftingFor?: string | null;
}

function goalToolPhase(input: GoalActiveToolPolicyInput): "drafting" | "tweakDrafting" | "normal" {
	if (input.confirmationActive) return "drafting";
	return input.tweakDraftingFor !== null && input.tweakDraftingFor !== undefined ? "tweakDrafting" : "normal";
}

function addTools(active: Set<string>, tools: Iterable<string>): void {
	for (const name of tools) active.add(name);
}

function resetGoalTools(active: Set<string>): void {
	active.delete(QUESTION_TOOL_NAME);
	active.delete(QUESTIONNAIRE_TOOL_NAME);
	for (const name of ACTIVE_GOAL_TOOL_NAMES) active.delete(name);
}

function applyTweakDraftingTools(active: Set<string>, input: GoalActiveToolPolicyInput): void {
	if (!input.goalId || input.tweakDraftingFor !== input.goalId) {
		active.delete(TWEAK_APPLY_TOOL_NAME);
		return;
	}
	active.add(TWEAK_APPLY_TOOL_NAME);
	active.add(QUESTION_TOOL_NAME);
	active.add(QUESTIONNAIRE_TOOL_NAME);
}

function applyQuestionTools(active: Set<string>, input: GoalActiveToolPolicyInput): void {
	if (input.confirmationActive) {
		active.add(QUESTION_TOOL_NAME);
		active.add(QUESTIONNAIRE_TOOL_NAME);
	} else if (input.goalStatus === "active") {
		addTools(active, GOAL_EXECUTION_WORK_TOOLS);
	}
}

export function computeGoalActiveTools(input: GoalActiveToolPolicyInput): string[] {
	const active = new Set(iterableToolNames(input.currentTools));
	addTools(active, GOAL_EXECUTION_WORK_TOOLS);
	resetGoalTools(active);
	addTools(active, lifecycleToolNamesForGoalStatus(input.goalStatus, goalToolPhase(input)));
	applyTweakDraftingTools(active, input);
	active.add(PROPOSE_DRAFT_TOOL_NAME);
	active.delete(CREATE_GOAL_TOOL_NAME);
	applyQuestionTools(active, input);
	return Array.from(active);
}

function isGoalLedgerRead(args: unknown): boolean {
	const filePath = asRecord(args)?.path;
	return typeof filePath === "string" && (filePath === ".pi/goals" || filePath.startsWith(".pi/goals/"));
}

function isEchoCommand(args: unknown): boolean {
	const command = asRecord(args)?.command;
	return typeof command === "string" && /^\s*echo\b/.test(command);
}

export function isMeaningfulProgressToolCall(toolName: string, args: unknown): boolean {
	if (!GOAL_PROGRESS_TOOL_SET.has(toolName)) return false;
	if (toolName === "read") return !isGoalLedgerRead(args);
	if (toolName === "bash") return !isEchoCommand(args);
	return true;
}

export interface GoalToolCallPolicyInput {
	toolName: string;
	args?: unknown;
	turnStoppedFor?: string | null;
	goalId?: string | null;
	goalStatus?: GoalStatus | null;
	goalAutoContinue?: boolean;
	confirmationActive: boolean;
	tweakDraftingActive: boolean;
}

export interface GoalToolCallPolicyDecision {
	blockReason?: string;
	countGetGoalNudge: boolean;
	resetGetGoalNudge: boolean;
	goalWorkToolCalledThisTurn: boolean;
	turnStoppedFor?: string | null;
}

function postStopBlockDecision(input: GoalToolCallPolicyInput): GoalToolCallPolicyDecision | null {
	if (input.turnStoppedFor === null || input.turnStoppedFor === undefined || POST_STOP_ALLOWED_TOOL_SET.has(input.toolName)) return null;
	return {
		blockReason: `The goal was already stopped earlier in this turn (goalId=${input.turnStoppedFor}). ` +
			`Do not call more tools; end the turn with a brief summary and yield to the user.`,
		countGetGoalNudge: false,
		resetGetGoalNudge: false,
		goalWorkToolCalledThisTurn: false,
	};
}

function shouldStopAutoContinueTurn(input: GoalToolCallPolicyInput, activeGoal: boolean, meaningfulProgress: boolean): boolean {
	return !meaningfulProgress && activeGoal && input.goalAutoContinue === true && input.toolName !== "get_goal";
}

export function evaluateGoalToolCall(input: GoalToolCallPolicyInput): GoalToolCallPolicyDecision {
	const blocked = postStopBlockDecision(input);
	if (blocked) return blocked;
	const activeGoal = input.goalStatus === "active" && !!input.goalId;
	const normalGoalTurn = !input.confirmationActive && !input.tweakDraftingActive && activeGoal;
	const meaningfulProgress = isMeaningfulProgressToolCall(input.toolName, input.args);
	return {
		countGetGoalNudge: normalGoalTurn && input.toolName === "get_goal",
		resetGetGoalNudge: meaningfulProgress && !!input.goalId,
		goalWorkToolCalledThisTurn: meaningfulProgress,
		turnStoppedFor: shouldStopAutoContinueTurn(input, activeGoal, meaningfulProgress) ? input.goalId ?? null : undefined,
	};
}

export function shouldQueueContinuationAtTurnEnd(input: {
	assistantUsedTool: boolean;
	goalStatus?: GoalStatus | null;
	goalAutoContinue?: boolean;
	goalWorkToolCalledThisTurn: boolean;
}): boolean {
	return !input.assistantUsedTool
		&& input.goalStatus === "active"
		&& input.goalAutoContinue === true
		&& input.goalWorkToolCalledThisTurn;
}
