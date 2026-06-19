export type GoalAuditorProgressPhase = "running" | "tool_executing" | "producing_report" | "done";

export interface GoalAuditorProgress {
	/** Current tool being executed by the auditor, if any */
	currentTool?: string;
	/** Arguments passed to the current tool (truncated for display) */
	currentToolArgs?: string;
	/** When the current tool started (ms since epoch) */
	currentToolStartedAt?: number;
	/** Recent text output lines from the auditor's assistant messages */
	recentOutput: string[];
	/** Phase of the audit */
	phase: GoalAuditorProgressPhase;
	/** Elapsed ms since audit started */
	elapsedMs: number;
}

export type AuditorProgressCallback = (progress: GoalAuditorProgress) => void;

export function elapsedSecondsFromMs(elapsedMs: number): number {
	if (!Number.isFinite(elapsedMs)) return 0;
	return Math.max(0, Math.floor(elapsedMs / 1000));
}

export function currentToolElapsedSeconds(progress: Pick<GoalAuditorProgress, "currentToolStartedAt">, now = Date.now()): number | null {
	if (typeof progress.currentToolStartedAt !== "number" || !Number.isFinite(progress.currentToolStartedAt)) return null;
	return elapsedSecondsFromMs(now - progress.currentToolStartedAt);
}
