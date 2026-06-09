/**
 * Pure foreground run-state derivation.
 *
 * Takes a foreground `Details` snapshot and returns a structured model describing
 * the run: header label, item title, total count, step spans, active-parallel-group
 * window, and per-row label/status. The renderer DRAWS this model instead of
 * computing run-state inline at draw time. No theme/IO here.
 *
 * The async/widget view does not use this model — it already reads precomputed
 * fields from `async-job-tracker.ts` and uses `aggregateStepStatus` (see
 * `render-progress-model/design.md` ADR-0001). Only the span builder
 * (`chain-spans.ts`) and the status precedence (`resultStatus`) are shared.
 */

import type { Details } from "../shared/types.ts";
import { resultStatus, type ResultStatus, formatAgentRunningLabel } from "../shared/status-format.ts";
import { buildChainStepSpansFromLabels, parseParallelGroupAgentCount, type ChainStepSpan } from "./chain-spans.ts";

export type RowStatus = ResultStatus;

export interface ForegroundRunRow {
	index: number;
	label: string;
	status: RowStatus;
	done: boolean;
}

export interface ForegroundRunModel {
	header: string;
	itemTitle: "Step" | "Agent";
	totalCount: number;
	hasParallelInChain: boolean;
	spans: ChainStepSpan[];
	activeGroup?: { start: number; end: number };
	rows: ForegroundRunRow[];
}

type ForegroundDetails = Pick<Details, "mode" | "results" | "progress" | "totalSteps" | "currentStepIndex" | "chainAgents">;

function isChainParallelGroupActive(details: Pick<Details, "mode" | "chainAgents" | "currentStepIndex">): boolean {
	if (details.mode !== "chain") return false;
	if (details.currentStepIndex === undefined) return false;
	const currentLabel = details.chainAgents?.[details.currentStepIndex];
	return parseParallelGroupAgentCount(currentLabel) !== undefined;
}

function isDoneResult(result: Details["results"][number]): boolean {
	return resultStatus(result) === "completed";
}

/**
 * The header/counts/itemTitle/active-group derivation. Reproduces the four
 * branches (parallel, active-group, chain, single) field-for-field.
 */
function deriveHeader(details: ForegroundDetails, spans: ChainStepSpan[], activeParallelGroup: boolean, hasRunning: boolean): {
	header: string;
	itemTitle: "Step" | "Agent";
	totalCount: number;
	activeGroup?: { start: number; end: number };
} {
	const itemTitle: "Step" | "Agent" = details.mode === "parallel" || activeParallelGroup ? "Agent" : "Step";

	if (details.mode === "parallel") {
		const totalCount = details.totalSteps ?? details.results.length;
		const statuses = new Array(totalCount).fill("pending") as Array<"pending" | "running" | "completed" | "failed" | "detached">;
		for (const progress of details.progress ?? []) {
			if (progress.index >= 0 && progress.index < totalCount) statuses[progress.index] = progress.status;
		}
		for (let i = 0; i < details.results.length; i++) {
			const result = details.results[i]!;
			const progressFromArray = details.progress?.find((progress) => progress.index === i)
				|| details.progress?.find((progress) => progress.agent === result.agent && progress.status === "running");
			const index = result.progress?.index ?? progressFromArray?.index ?? i;
			if (index < 0 || index >= totalCount) continue;
			statuses[index] = resultStatus(result);
		}
		const running = statuses.filter((status) => status === "running").length;
		const done = statuses.filter((status) => status === "completed").length;
		const header = hasRunning
			? `${formatAgentRunningLabel(running)} · ${done}/${totalCount} done`
			: `${done}/${totalCount} done`;
		return { header, itemTitle, totalCount };
	}

	if (activeParallelGroup) {
		const currentStepIndex = details.currentStepIndex!;
		const span = spans[currentStepIndex];
		const groupSize = span?.count ?? 1;
		const groupStart = span?.start ?? 0;
		const groupEnd = groupStart + groupSize;
		let running = 0;
		let done = 0;
		for (let index = groupStart; index < groupEnd; index++) {
			const progressEntry = details.progress?.find((progress) => progress.index === index);
			const resultEntry = details.results.find((result) => result.progress?.index === index);
			if (progressEntry?.status === "running") {
				running++;
				continue;
			}
			if (progressEntry?.status === "completed") {
				done++;
				continue;
			}
			if (resultEntry && isDoneResult(resultEntry)) done++;
		}
		const totalSteps = details.totalSteps ?? details.chainAgents?.length ?? 1;
		const header = hasRunning
			? `step ${currentStepIndex + 1}/${totalSteps} · parallel group: ${formatAgentRunningLabel(running)} · ${done}/${groupSize} done`
			: `step ${currentStepIndex + 1}/${totalSteps} · parallel group: ${done}/${groupSize} done`;
		return { header, itemTitle, totalCount: groupSize, activeGroup: { start: groupStart, end: groupEnd } };
	}

	if (details.mode === "chain" && details.chainAgents?.length) {
		const totalCount = details.totalSteps ?? details.chainAgents.length;
		const doneLogical = spans.filter((span) => {
			for (let index = span.start; index < span.start + span.count; index++) {
				const progressEntry = details.progress?.find((progress) => progress.index === index);
				const resultEntry = details.results.find((result) => result.progress?.index === index) ?? details.results[index];
				if (progressEntry?.status === "running" || progressEntry?.status === "pending") return false;
				if (resultEntry && !isDoneResult(resultEntry)) return false;
			}
			return true;
		}).length;
		const currentStep = details.currentStepIndex !== undefined ? details.currentStepIndex + 1 : Math.min(totalCount, doneLogical + (hasRunning ? 1 : 0));
		const header = hasRunning ? `step ${currentStep}/${totalCount}` : `step ${doneLogical}/${totalCount}`;
		return { header, itemTitle, totalCount };
	}

	const totalCount = details.totalSteps ?? details.results.length;
	const currentStep = details.currentStepIndex !== undefined ? details.currentStepIndex + 1 : Math.min(totalCount, details.results.filter(isDoneResult).length + (hasRunning ? 1 : 0));
	const done = details.results.filter(isDoneResult).length;
	const header = hasRunning ? `step ${currentStep}/${totalCount}` : `step ${done}/${totalCount}`;
	return { header, itemTitle, totalCount };
}

/** Per-result step number, matching the renderers' inline derivation. */
function stepNumberFor(details: ForegroundDetails, resultIndex: number): number {
	const result = details.results[resultIndex]!;
	const progressFromArray = details.progress?.find((progress) => progress.index === resultIndex)
		|| details.progress?.find((progress) => progress.agent === result.agent && progress.status === "running");
	return (result.progress?.index ?? progressFromArray?.index ?? resultIndex) + 1;
}

function rowLabel(
	details: ForegroundDetails,
	context: { itemTitle: "Step" | "Agent"; totalCount: number; hasParallelInChain: boolean; activeParallelGroup: boolean; groupStart: number },
	resultIndex: number,
	stepNumber: number,
): string {
	if (details.mode === "chain" && context.hasParallelInChain) {
		const span = buildChainStepSpansFromLabels(details.chainAgents).find((candidate) => resultIndex >= candidate.start && resultIndex < candidate.start + candidate.count);
		if (span?.isParallel) return `Agent ${resultIndex - span.start + 1}/${span.count}`;
		if (span) return `Step ${span.stepIndex + 1}`;
	}
	if (context.itemTitle === "Agent") {
		const localStepNumber = context.activeParallelGroup
			? Math.max(1, stepNumber - context.groupStart)
			: stepNumber;
		return `Agent ${localStepNumber}/${context.totalCount}`;
	}
	return `Step ${stepNumber}`;
}

/**
 * Derive the structured foreground run model from a `Details` snapshot.
 * Replaces the inline `buildMultiProgressLabel` + `resultRowLabel` computation.
 */
export function deriveForegroundRunModel(details: ForegroundDetails, hasRunning: boolean): ForegroundRunModel {
	const spans = buildChainStepSpansFromLabels(details.chainAgents);
	const hasParallelInChain = details.mode === "chain" && spans.some((span) => span.isParallel);
	const activeParallelGroup = isChainParallelGroupActive(details);
	const { header, itemTitle, totalCount, activeGroup } = deriveHeader(details, spans, activeParallelGroup, hasRunning);
	const groupStart = activeGroup?.start ?? 0;

	const rows: ForegroundRunRow[] = details.results.map((result, index) => {
		const status = resultStatus(result);
		return {
			index,
			label: rowLabel(details, { itemTitle, totalCount, hasParallelInChain, activeParallelGroup, groupStart }, index, stepNumberFor(details, index)),
			status,
			done: status === "completed",
		};
	});

	return { header, itemTitle, totalCount, hasParallelInChain, spans, activeGroup, rows };
}
