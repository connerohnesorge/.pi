import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildCompletionReport } from "./goal-policy.ts";
import { cloneGoal, nowIso, type GoalFocusReason, type GoalRecord, type GoalStateEntry } from "./goal-record.ts";
import type { GoalFileContext } from "./storage/goal-files.ts";

export type CompletionReportVariant =
	| { auditSkippedReason: string }
	| { auditorReport: string };

export function goalStateDetails(goal: GoalRecord | null): GoalStateEntry {
	return { version: 3, goal: goal ? cloneGoal(goal) : null };
}

export interface GoalCompletionRuntimePorts {
	getGoal: () => GoalRecord | null;
	setGoal: (goal: GoalRecord | null) => void;
	writeActiveGoalFile: (ctx: GoalFileContext, goal: GoalRecord) => GoalRecord;
	archiveGoalFile: (ctx: GoalFileContext, goal: GoalRecord) => GoalRecord;
	appendStateEntry: (goal: GoalRecord | null) => void;
	appendFocusEntry: (goalId: string | null, reason: GoalFocusReason) => void;
	appendGoalCompletedEvent: (ctx: ExtensionContext, completedGoal: GoalRecord, archivedGoal: GoalRecord) => void;
	accountProgress: (ctx: ExtensionContext) => void;
	clearAuditProgress: () => void;
	invalidateGoalWidget: () => void;
	setTurnStoppedFor: (goalId: string | null) => void;
	resetGetGoalNudgeState: (goalId: string | null | undefined) => void;
	removeGoalFromPool: (goalId: string) => void;
	clearFocus: () => void;
	syncGoalTools: () => void;
	updateUI: (ctx: ExtensionContext) => void;
	detailedSummary: (goal: GoalRecord | null) => string;
}

export interface FinalizeGoalCompletionArgs {
	goal: GoalRecord;
	variant: CompletionReportVariant;
	completionSummary?: string | null;
}

export interface DeferredArchiveResult {
	completedGoal: GoalRecord;
	archivedGoal: GoalRecord;
}

export function createGoalCompletionRuntime(ports: GoalCompletionRuntimePorts): {
	finalizeGoalCompletion: (ctx: ExtensionContext, args: FinalizeGoalCompletionArgs) => AgentToolResult<GoalStateEntry>;
	archiveCompletedGoalAtTurnEnd: (ctx: ExtensionContext) => DeferredArchiveResult | null;
} {
	return {
		finalizeGoalCompletion(ctx, args) {
			ports.accountProgress(ctx);
			ports.clearAuditProgress();
			ports.invalidateGoalWidget();
			let completed: GoalRecord = {
				...args.goal,
				status: "complete",
				stopReason: "agent",
				updatedAt: nowIso(),
			};
			completed = ports.writeActiveGoalFile(ctx, completed);
			ports.setGoal(completed);
			ports.appendStateEntry(completed);
			ports.setTurnStoppedFor(completed.id);
			ports.resetGetGoalNudgeState(completed.id);
			ports.syncGoalTools();
			ports.updateUI(ctx);
			return {
				content: [{
					type: "text",
					text: buildCompletionReport({
						detailedSummary: ports.detailedSummary(completed),
						completionSummary: args.completionSummary,
						...args.variant,
					}),
				}],
				details: goalStateDetails(completed),
				terminate: true,
			};
		},

		archiveCompletedGoalAtTurnEnd(ctx) {
			const completedGoal = ports.getGoal();
			if (completedGoal?.status !== "complete" || completedGoal.archivedPath) return null;
			const archivedGoal = ports.archiveGoalFile(ctx, completedGoal);
			ports.resetGetGoalNudgeState(completedGoal.id);
			ports.removeGoalFromPool(completedGoal.id);
			ports.clearFocus();
			ports.appendFocusEntry(null, "completed");
			ports.syncGoalTools();
			ports.updateUI(ctx);
			ports.appendGoalCompletedEvent(ctx, completedGoal, archivedGoal);
			return { completedGoal, archivedGoal };
		},
	};
}
