import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { truncateText } from "./goal-core.ts";
import { goalStateDetails } from "./goal-completion-runtime.ts";
import { nowIso, type GoalRecord, type GoalStateEntry } from "./goal-record.ts";
import type { GoalFileContext } from "./storage/goal-files.ts";

export interface GoalObjectiveRuntimePorts {
	setGoal: (goal: GoalRecord) => void;
	writeActiveGoalFile: (ctx: GoalFileContext, goal: GoalRecord) => GoalRecord;
	appendStateEntry: (goal: GoalRecord | null) => void;
	appendGoalTweakedEvent: (ctx: ExtensionContext, goal: GoalRecord, changeSummary: string) => void;
	clearTweakDrafting: () => void;
	resetGetGoalNudgeState: (goalId: string | null | undefined) => void;
	setTurnStoppedFor: (goalId: string | null) => void;
	syncGoalTools: () => void;
	updateUI: (ctx: ExtensionContext) => void;
	notify: (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => void;
}

export interface GoalObjectiveUpdateResult {
	goal: GoalRecord;
	details: GoalStateEntry;
}

export interface GoalTweakResult extends GoalObjectiveUpdateResult {
	text: string;
	terminate: true;
}

export function createGoalObjectiveRuntime(ports: GoalObjectiveRuntimePorts): {
	applyObjectiveUpdate: (ctx: ExtensionContext, goal: GoalRecord, args: { newObjective: string; changeSummary?: string }) => GoalObjectiveUpdateResult;
	applyGoalTweak: (ctx: ExtensionContext, goal: GoalRecord, args: { newObjective: string; changeSummary: string }) => GoalTweakResult;
} {
	return {
		applyObjectiveUpdate(ctx, goal, args) {
			const next: GoalRecord = {
				...goal,
				objective: args.newObjective,
				updatedAt: nowIso(),
			};
			const written = ports.writeActiveGoalFile(ctx, next);
			ports.setGoal(written);
			ports.appendStateEntry(written);
			ports.appendGoalTweakedEvent(ctx, written, args.changeSummary ?? "Objective updated via update_goal");
			ports.syncGoalTools();
			ports.updateUI(ctx);
			return { goal: written, details: goalStateDetails(written) };
		},

		applyGoalTweak(ctx, goal, args) {
			const next: GoalRecord = {
				...goal,
				objective: args.newObjective,
				updatedAt: nowIso(),
				// Clear any prior agent pause reason — the user has redefined the work.
				pauseReason: undefined,
				pauseSuggestedAction: undefined,
			};
			const written = ports.writeActiveGoalFile(ctx, next);
			ports.setGoal(written);
			ports.appendStateEntry(written);
			ports.clearTweakDrafting();
			ports.resetGetGoalNudgeState(written.id);
			ports.setTurnStoppedFor(written.id);
			ports.syncGoalTools();
			ports.updateUI(ctx);
			ports.notify(ctx, `Goal tweaked: ${truncateText(args.changeSummary, 160)}`, "info");
			ports.appendGoalTweakedEvent(ctx, written, args.changeSummary);
			return {
				goal: written,
				details: goalStateDetails(written),
				text: `Goal tweak applied. ${args.changeSummary}\nStop now; the next continuation will arrive automatically if the goal is active.`,
				terminate: true,
			};
		},
	};
}
