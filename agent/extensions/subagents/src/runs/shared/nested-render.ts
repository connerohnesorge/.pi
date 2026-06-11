// fallow-ignore-file code-duplication
import { formatDuration, formatTokens, shortenPath } from "../../shared/formatters.ts";
import { formatActivityLabel } from "../../shared/status-format.ts";
import type { ActivityState, NestedRunSummary, NestedStepSummary } from "../../shared/types.ts";

interface NestedRunCounts {
	total: number;
	running: number;
	paused: number;
	complete: number;
	failed: number;
	queued: number;
}

function countNestedRuns(children: NestedRunSummary[] | undefined): NestedRunCounts {
	const counts: NestedRunCounts = { total: 0, running: 0, paused: 0, complete: 0, failed: 0, queued: 0 };
	for (const child of children ?? []) {
		counts.total++;
		counts[child.state]++;
		const nested = countNestedRuns([...(child.children ?? []), ...(child.steps?.flatMap((step) => step.children ?? []) ?? [])]);
		counts.total += nested.total;
		counts.running += nested.running;
		counts.paused += nested.paused;
		counts.complete += nested.complete;
		counts.failed += nested.failed;
		counts.queued += nested.queued;
	}
	return counts;
}

export function formatNestedAggregate(children: NestedRunSummary[] | undefined): string | undefined {
	const counts = countNestedRuns(children);
	if (counts.total === 0) return undefined;
	const parts = [
		counts.running > 0 ? `${counts.running} running` : "",
		counts.paused > 0 ? `${counts.paused} paused` : "",
		counts.failed > 0 ? `${counts.failed} failed` : "",
		counts.complete > 0 ? `${counts.complete} complete` : "",
		counts.queued > 0 ? `${counts.queued} queued` : "",
	].filter(Boolean);
	return `+${counts.total} nested run${counts.total === 1 ? "" : "s"}${parts.length ? ` (${parts.join(", ")})` : ""}`;
}

function nestedRunLabel(run: NestedRunSummary): string {
	if (run.agent) return run.agent;
	if (run.agents?.length) return run.agents.length === 1 ? run.agents[0]! : `${run.agents.slice(0, 2).join(", ")}${run.agents.length > 2 ? ` +${run.agents.length - 2}` : ""}`;
	return run.id;
}

function formatNestedActivity(input: {
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	totalTokens?: NestedRunSummary["totalTokens"];
}): string | undefined {
	const facts: string[] = [];
	if (input.currentTool && input.currentToolStartedAt !== undefined) facts.push(`tool ${input.currentTool} ${formatDuration(Math.max(0, Date.now() - input.currentToolStartedAt))}`);
	else if (input.currentTool) facts.push(`tool ${input.currentTool}`);
	if (input.currentPath) facts.push(shortenPath(input.currentPath));
	if (input.turnCount !== undefined) facts.push(`${input.turnCount} turns`);
	if (input.toolCount !== undefined) facts.push(`${input.toolCount} tools`);
	if (input.totalTokens) facts.push(`${formatTokens(input.totalTokens.total)} tok`);
	const activity = formatActivityLabel(input.lastActivityAt, input.activityState as ActivityState | undefined);
	return activity || facts.length ? [activity, ...facts].filter(Boolean).join(" | ") : undefined;
}

export interface NestedWalkOptions {
	maxDepth: number;
	maxLines: number;
	indent?: string;
	renderRun(run: NestedRunSummary, depth: number, prefix: string): string;
	renderStep(step: NestedStepSummary, stepIndex: number, prefix: string): string;
	renderAggregate(text: string, prefix: string): string;
	afterRun?(run: NestedRunSummary, prefix: string): string | undefined;
	postProcess?(lines: string[]): string[];
}

export function walkNestedRuns(children: NestedRunSummary[] | undefined, options: NestedWalkOptions): string[] {
	const lines: string[] = [];
	const append = (items: NestedRunSummary[] | undefined, depth: number, prefix: string): void => {
		if (!items?.length || lines.length >= options.maxLines) return;
		if (depth > options.maxDepth) {
			const aggregate = formatNestedAggregate(items);
			if (aggregate && lines.length < options.maxLines) lines.push(options.renderAggregate(aggregate, prefix));
			return;
		}
		for (let index = 0; index < items.length; index++) {
			const child = items[index]!;
			if (lines.length >= options.maxLines) {
				const aggregate = formatNestedAggregate(items.slice(index));
				if (aggregate) lines[lines.length - 1] = options.renderAggregate(aggregate, prefix);
				return;
			}
			lines.push(options.renderRun(child, depth, prefix));
			if (options.afterRun && lines.length < options.maxLines) {
				const extra = options.afterRun(child, prefix);
				if (extra !== undefined) lines.push(extra);
			}
			if (depth === options.maxDepth) {
				const aggregate = formatNestedAggregate([...(child.steps?.flatMap((step) => step.children ?? []) ?? []), ...(child.children ?? [])]);
				if (aggregate && lines.length < options.maxLines) lines.push(options.renderAggregate(aggregate, `${prefix}  `));
				continue;
			}
			for (const [stepIndex, step] of (child.steps ?? []).entries()) {
				if (lines.length >= options.maxLines) return;
				const stepPrefix = `${prefix}  `;
				lines.push(options.renderStep(step, stepIndex, stepPrefix));
				append(step.children, depth + 1, `${stepPrefix}  `);
			}
			append(child.children, depth + 1, `${prefix}  `);
		}
	};
	append(children, 0, options.indent ?? "");
	return options.postProcess ? options.postProcess(lines) : lines;
}

function formatNestedRunLines(children: NestedRunSummary[] | undefined, options: { indent: string; maxDepth: number; maxLines: number; commandHints?: boolean }): string[] {
	return walkNestedRuns(children, {
		indent: options.indent,
		maxDepth: options.maxDepth,
		maxLines: options.maxLines,
		renderRun: (child, _depth, prefix) => {
			const activity = child.state === "running" ? formatNestedActivity(child) : undefined;
			const error = child.error ? ` | error: ${child.error}` : "";
			return `${prefix}↳ ${nestedRunLabel(child)} [${child.id}] ${child.state}${activity ? ` | ${activity}` : ""}${error}`;
		},
		renderStep: (step, stepIndex, prefix) => {
			const stepActivity = step.status === "running" ? formatNestedActivity(step) : undefined;
			return `${prefix}${stepIndex + 1}. ${step.agent} ${step.status}${stepActivity ? ` | ${stepActivity}` : ""}${step.error ? ` | error: ${step.error}` : ""}`;
		},
		renderAggregate: (text, prefix) => `${prefix}↳ ${text}`,
		afterRun: options.commandHints ? (child, prefix) => `${prefix}  Status: subagent({ action: "status", id: "${child.id}" })` : undefined,
	});
}

export function formatNestedRunStatusLines(children: NestedRunSummary[] | undefined, options: { indent?: string; maxDepth?: number; maxLines?: number; commandHints?: boolean } = {}): string[] {
	return formatNestedRunLines(children, {
		indent: options.indent ?? "  ",
		maxDepth: options.maxDepth ?? 2,
		maxLines: options.maxLines ?? 40,
		commandHints: options.commandHints ?? false,
	});
}
