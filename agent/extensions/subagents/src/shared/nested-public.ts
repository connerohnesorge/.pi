import type { NestedStepSummary, PublicNestedRunSummary, PublicNestedStepSummary } from "./types.ts";

export function publicNestedStepSummary(
	step: NestedStepSummary | PublicNestedStepSummary,
	children?: PublicNestedRunSummary[],
): PublicNestedStepSummary {
	return {
		agent: step.agent,
		status: step.status,
		...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
		...(step.activityState ? { activityState: step.activityState } : {}),
		...(step.lastActivityAt !== undefined ? { lastActivityAt: step.lastActivityAt } : {}),
		...(step.currentTool ? { currentTool: step.currentTool } : {}),
		...(step.currentToolStartedAt !== undefined ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
		...(step.currentPath ? { currentPath: step.currentPath } : {}),
		...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
		...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
		...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
		...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
		...(step.error ? { error: step.error } : {}),
		...(children?.length ? { children } : {}),
	};
}
