/**
 * Foreground control contract.
 *
 * Owns the supervisor's live view of a running foreground subagent: the shared
 * `ForegroundControl` type plus the operations every foreground run path calls to
 * mirror the child's progress and wire/clear its interrupt. Centralising these here
 * gives the previously-implicit contract a single, compiler-checked home so a new
 * progress field is declared once and copied once.
 */

import type {
	ActivityState,
	AgentProgress,
	NestedRouteInfo,
	NestedRunSummary,
	SubagentRunMode,
} from "../../shared/types.ts";

/**
 * The supervisor's live record of a running foreground subagent.
 *
 * The "head" (`currentAgent`/`currentIndex`) is derived per run path and set by the
 * caller (see ADR-0001); the "tail" (activity/tool/path/turn/token/tool-count) is
 * copied by {@link applyProgressToForegroundControl}.
 */
export interface ForegroundControl {
	runId: string;
	mode: SubagentRunMode;
	startedAt: number;
	updatedAt: number;
	currentAgent?: string;
	currentIndex?: number;
	currentActivityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	tokens?: number;
	toolCount?: number;
	nestedRoute?: NestedRouteInfo;
	nestedChildren?: NestedRunSummary[];
	interrupt?: () => boolean;
}

/**
 * Mark the start of a step on the control record: set the caller-derived head,
 * clear the activity state, and advance `updatedAt`. The caller derives
 * `agent`/`index` from its own locals (see ADR-0001); this owns the assignment
 * mechanics only.
 */
export function markControlStart(control: ForegroundControl, agent: string, index: number): void {
	control.currentAgent = agent;
	control.currentIndex = index;
	control.currentActivityState = undefined;
	control.updatedAt = Date.now();
}

/**
 * Mirror the child's latest progress onto the control record's "tail" and advance
 * `updatedAt`. Deliberately does NOT touch `currentAgent`/`currentIndex` (the head),
 * which the calling path owns (see ADR-0001).
 */
export function applyProgressToForegroundControl(control: ForegroundControl, progress: AgentProgress | undefined): void {
	control.currentActivityState = progress?.activityState;
	control.lastActivityAt = progress?.lastActivityAt;
	control.currentTool = progress?.currentTool;
	control.currentToolStartedAt = progress?.currentToolStartedAt;
	control.currentPath = progress?.currentPath;
	control.turnCount = progress?.turnCount;
	control.tokens = progress?.tokens;
	control.toolCount = progress?.toolCount;
	control.updatedAt = Date.now();
}

/**
 * Wire the control record's interrupt to a run's abort controller: clear the
 * activity state, advance `updatedAt`, and install an interrupt closure that aborts
 * the run exactly once (subsequent calls are a no-op returning `false`).
 */
export function wireForegroundInterrupt(control: ForegroundControl, interruptController: AbortController): void {
	control.currentActivityState = undefined;
	control.updatedAt = Date.now();
	control.interrupt = () => {
		if (interruptController.signal.aborted) return false;
		interruptController.abort();
		control.currentActivityState = undefined;
		control.updatedAt = Date.now();
		return true;
	};
}

/**
 * Detach the control record's interrupt handle after a run completes.
 */
export function clearControlInterrupt(control: ForegroundControl): void {
	control.interrupt = undefined;
}
