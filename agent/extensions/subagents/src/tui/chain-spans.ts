/**
 * Shared flat-index → logical-chain-step / parallel-group span mapping.
 *
 * Both the foreground result view (driven by a `chainAgents` label array) and the
 * async widget view (driven by a `parallelGroups` status array) map a flat result
 * index onto its logical chain step or parallel group. This is the single home for
 * that mapping: the foreground path uses {@link buildChainStepSpansFromLabels} and
 * the async path uses {@link buildChainStepSpansFromGroups}; both produce the same
 * `ChainStepSpan[]` shape.
 */

import type { AsyncParallelGroupStatus } from "../shared/types.ts";

export interface ChainStepSpan {
	stepIndex: number;
	start: number;
	count: number;
	isParallel: boolean;
}

/**
 * Parse a chain-agent label of the form `[a + b]` into the number of agents in
 * the parallel group. Returns `undefined` for a non-group (plain) step label.
 */
export function parseParallelGroupAgentCount(label: string | undefined): number | undefined {
	if (!label || !label.startsWith("[") || !label.endsWith("]")) return undefined;
	const inner = label.slice(1, -1).trim();
	if (!inner) return 0;
	return inner.split("+").map((part) => part.trim()).filter(Boolean).length;
}

/**
 * Label-derived entry point (foreground `Details.chainAgents`): each label is one
 * logical step, and a `[a + b]`-style label spans its parsed agent count.
 */
export function buildChainStepSpansFromLabels(chainAgents: string[] | undefined): ChainStepSpan[] {
	if (!chainAgents?.length) return [];
	const spans: ChainStepSpan[] = [];
	let start = 0;
	for (let stepIndex = 0; stepIndex < chainAgents.length; stepIndex++) {
		const label = chainAgents[stepIndex]!;
		const parsedCount = parseParallelGroupAgentCount(label);
		const count = parsedCount ?? 1;
		spans.push({ stepIndex, start, count, isParallel: parsedCount !== undefined });
		start += count;
	}
	return spans;
}

/**
 * Group-array-derived entry point (async `AsyncJobState.parallelGroups`): each
 * logical step is either a parallel group (from the array) or a single flat step.
 */
export function buildChainStepSpansFromGroups(total: number, stepCount: number, parallelGroups: AsyncParallelGroupStatus[] = []): ChainStepSpan[] {
	const spans: ChainStepSpan[] = [];
	let flatIndex = 0;
	for (let stepIndex = 0; stepIndex < total; stepIndex++) {
		const group = parallelGroups.find((candidate) => candidate.stepIndex === stepIndex);
		if (group) {
			spans.push({ stepIndex, start: group.start, count: group.count, isParallel: true });
			flatIndex = Math.max(flatIndex, group.start + group.count);
			continue;
		}
		spans.push({ stepIndex, start: flatIndex, count: flatIndex < stepCount ? 1 : 0, isParallel: false });
		flatIndex++;
	}
	return spans;
}
