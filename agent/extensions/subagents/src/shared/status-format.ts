import type { ActivityState, AsyncJobStep, SingleResult } from "./types.ts";

type StepStatusLike = Pick<AsyncJobStep, "status">;

/** Per-result status for the foreground run view; sibling of {@link aggregateStepStatus}. */
export type ResultStatus = "completed" | "running" | "pending" | "failed" | "detached";

type ResultStatusLike = Pick<SingleResult, "progress" | "interrupted" | "detached" | "exitCode">;

/**
 * Foreground per-result status precedence: an explicit progress status wins;
 * otherwise an interrupted/detached result is detached, and the exit code decides
 * completed vs failed. Defined here beside {@link aggregateStepStatus} so the
 * foreground per-result and async per-step status notions live in one place.
 */
export function resultStatus(result: ResultStatusLike): ResultStatus {
	const status = result.progress?.status;
	if (status) return status;
	if (result.interrupted || result.detached) return "detached";
	return result.exitCode === 0 ? "completed" : "failed";
}

function formatActivityAge(ms: number): string {
	if (ms < 1000) return "now";
	if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
	return `${Math.floor(ms / 60000)}m`;
}

export function formatActivityLabel(lastActivityAt: number | undefined, activityState?: ActivityState, now = Date.now()): string | undefined {
	if (lastActivityAt === undefined) {
		if (activityState === "needs_attention") return "needs attention";
		if (activityState === "active_long_running") return "active but long-running";
		return undefined;
	}
	const age = formatActivityAge(Math.max(0, now - lastActivityAt));
	if (activityState === "needs_attention") return `no activity for ${age}`;
	if (activityState === "active_long_running") return `active but long-running · last activity ${age} ago`;
	return age === "now" ? "active now" : `active ${age} ago`;
}

function isCompletedStepStatus(status: AsyncJobStep["status"]): boolean {
	return status === "complete" || status === "completed";
}

export function aggregateStepStatus(steps: StepStatusLike[]): AsyncJobStep["status"] {
	if (steps.some((step) => step.status === "running")) return "running";
	if (steps.some((step) => step.status === "failed")) return "failed";
	if (steps.some((step) => step.status === "paused")) return "paused";
	if (steps.length > 0 && steps.every((step) => isCompletedStepStatus(step.status))) return "complete";
	return "pending";
}

export function formatAgentRunningLabel(count: number): string {
	return count === 1 ? "1 agent running" : `${count} agents running`;
}

export function formatParallelOutcome(steps: StepStatusLike[], total: number, options: { showRunning?: boolean } = {}): string {
	const running = steps.filter((step) => step.status === "running").length;
	const done = steps.filter((step) => isCompletedStepStatus(step.status)).length;
	const failed = steps.filter((step) => step.status === "failed").length;
	const paused = steps.filter((step) => step.status === "paused").length;
	const parts = [`${done}/${total} done`];
	if (options.showRunning !== false && running > 0) parts.unshift(formatAgentRunningLabel(running));
	if (failed > 0) parts.push(`${failed} failed`);
	if (paused > 0) parts.push(`${paused} paused`);
	return parts.join(" · ");
}
