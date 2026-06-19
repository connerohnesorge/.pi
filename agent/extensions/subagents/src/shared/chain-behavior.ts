import * as path from "node:path";
import type { AgentConfig } from "../agents/agents.ts";
import { normalizeSkillInput } from "./skill-input.ts";
import { normalizeSingleOutputOverride } from "../runs/shared/single-output.ts";
import type { OutputMode } from "./types.ts";

export interface ResolvedStepBehavior {
	output: string | false;
	outputMode: OutputMode;
	reads: string[] | false;
	progress: boolean;
	skills: string[] | false;
	model?: string;
}

export interface StepOverrides {
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	progress?: boolean;
	skills?: string[] | false;
	model?: string;
}

// Delegate to the single output-sentinel rule so there is exactly one decode.
// The resolved layer never carries the boolean `true`/`"true"` sentinels, so no
// agent default is needed here (`"false"`/`false`->false, path passthrough).
function normalizeOutputOverride(output: string | false | undefined): string | false | undefined {
	return normalizeSingleOutputOverride(output, undefined);
}

/** Sequential step: single agent execution */
export interface SequentialStep {
	agent: string;
	task?: string;
	cwd?: string;
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	progress?: boolean;
	skill?: string | string[] | false;
	model?: string;
}

/** Parallel task item within a parallel step */
export interface ParallelTaskItem {
	agent: string;
	task?: string;
	cwd?: string;
	count?: number;
	output?: string | false;
	outputMode?: OutputMode;
	reads?: string[] | false;
	progress?: boolean;
	skill?: string | string[] | false;
	model?: string;
}

/** Parallel step: multiple agents running concurrently */
export interface ParallelStep {
	parallel: ParallelTaskItem[];
	concurrency?: number;
	failFast?: boolean;
	worktree?: boolean;
}

/** Union type for chain steps */
export type ChainStep = SequentialStep | ParallelStep;

export function isParallelStep(step: ChainStep): step is ParallelStep {
	return "parallel" in step && Array.isArray((step as ParallelStep).parallel);
}

/** Get all agent names in a step (single for sequential, multiple for parallel) */
export function getStepAgents(step: ChainStep): string[] {
	if (isParallelStep(step)) {
		return step.parallel.map((t) => t.agent);
	}
	return [step.agent];
}

/** Resolved templates for a chain - string for sequential, string[] for parallel */
export type ResolvedTemplates = (string | string[])[];

/**
 * Resolve templates for a chain with parallel step support.
 * Returns string for sequential steps, string[] for parallel steps.
 */
export function resolveChainTemplates(
	steps: ChainStep[],
): ResolvedTemplates {
	return steps.map((step, i) => {
		if (isParallelStep(step)) {
			// Parallel step: resolve each task's template
			return step.parallel.map((task) => {
				if (task.task) return task.task;
				// Default for parallel tasks is {previous}
				return "{previous}";
			});
		}
		// Sequential step: existing logic
		const seq = step as SequentialStep;
		if (seq.task) return seq.task;
		// Default: first step uses {task}, others use {previous}
		return i === 0 ? "{task}" : "{previous}";
	});
}

/**
 * Resolve effective chain behavior per step.
 * Priority: step override > agent frontmatter > false (disabled)
 */
export function resolveStepBehavior(
	agentConfig: AgentConfig,
	stepOverrides: StepOverrides,
	chainSkills?: string[],
): ResolvedStepBehavior {
	// Output: step override > frontmatter > false (no output)
	const stepOutput = normalizeOutputOverride(stepOverrides.output);
	const output =
		stepOutput !== undefined
			? stepOutput
			: normalizeOutputOverride(agentConfig.output) ?? false;

	// Reads: step override > frontmatter defaultReads > false (no reads)
	const reads =
		stepOverrides.reads !== undefined
			? stepOverrides.reads
			: agentConfig.defaultReads ?? false;

	// Progress: step override > frontmatter defaultProgress > false
	const progress =
		stepOverrides.progress !== undefined
			? stepOverrides.progress
			: agentConfig.defaultProgress ?? false;

	let skills: string[] | false;
	if (stepOverrides.skills === false) {
		skills = false;
	} else if (stepOverrides.skills !== undefined) {
		skills = [...stepOverrides.skills];
		if (chainSkills && chainSkills.length > 0) {
			skills = [...new Set([...skills, ...chainSkills])];
		}
	} else {
		skills = agentConfig.skills ? [...agentConfig.skills] : [];
		if (chainSkills && chainSkills.length > 0) {
			skills = [...new Set([...skills, ...chainSkills])];
		}
	}

	const outputMode = stepOverrides.outputMode ?? "inline";
	const model = stepOverrides.model ?? agentConfig.model;
	return { output, outputMode, reads, progress, skills, model };
}

function resolveTaskTextForFileUpdatePolicy(task: string | undefined, originalTask?: string): string | undefined {
	if (!task) return originalTask;
	return originalTask ? task.replaceAll("{task}", originalTask) : task;
}

export function taskDisallowsFileUpdates(task: string | undefined): boolean {
	if (!task) return false;
	return /\breview[- ]only\b/i.test(task)
		|| /\bread[- ]only\s+(?:review|audit|inspection|pass)\b/i.test(task)
		|| /\b(?:no|without)\s+(?:file\s+)?edits?\b/i.test(task)
		|| /\b(?:do not|don't|must not)\s+(?:edit|modify|write|touch)\b/i.test(task)
		|| /\bleave\s+files?\s+unchanged\b/i.test(task);
}

export function suppressProgressForReadOnlyTask(behavior: ResolvedStepBehavior, task: string | undefined, originalTask?: string): ResolvedStepBehavior {
	const policyTask = resolveTaskTextForFileUpdatePolicy(task, originalTask);
	return behavior.progress && taskDisallowsFileUpdates(policyTask) ? { ...behavior, progress: false } : behavior;
}

/**
 * Resolve behaviors for all tasks in a parallel step.
 * Creates namespaced output paths to avoid collisions.
 */
export function resolveParallelBehaviors(
	tasks: ParallelTaskItem[],
	agentConfigs: AgentConfig[],
	stepIndex: number,
	chainSkills?: string[],
): ResolvedStepBehavior[] {
	return tasks.map((task, taskIndex) => {
		const config = agentConfigs.find((a) => a.name === task.agent);
		if (!config) {
			throw new Error(`Unknown agent: ${task.agent}`);
		}

		// Build subdirectory path for this parallel task
		const subdir = path.join(`parallel-${stepIndex}`, `${taskIndex}-${task.agent}`);

		// Output: task override > agent default (namespaced) > false
		// Absolute paths pass through unchanged; relative paths get namespaced under subdir
		let output: string | false = false;
		const taskOutput = normalizeOutputOverride(task.output);
		const configOutput = normalizeOutputOverride(config.output);
		if (taskOutput !== undefined) {
			if (taskOutput === false) {
				output = false;
			} else if (path.isAbsolute(taskOutput)) {
				output = taskOutput; // Absolute path: use as-is
			} else {
				output = path.join(subdir, taskOutput); // Relative: namespace under subdir
			}
		} else if (configOutput) {
			// Agent defaults are always relative, so namespace them
			output = path.join(subdir, configOutput);
		}

		// Reads: task override > agent default > false
		const reads =
			task.reads !== undefined ? task.reads : config.defaultReads ?? false;

		// Progress: task override > agent default > false
		const progress =
			task.progress !== undefined
				? task.progress
				: config.defaultProgress ?? false;

		const taskSkillInput = normalizeSkillInput(task.skill);
		let skills: string[] | false;
		if (taskSkillInput === false) {
			skills = false;
		} else if (taskSkillInput !== undefined) {
			skills = [...taskSkillInput];
			if (chainSkills && chainSkills.length > 0) {
				skills = [...new Set([...skills, ...chainSkills])];
			}
		} else {
			skills = config.skills ? [...config.skills] : [];
			if (chainSkills && chainSkills.length > 0) {
				skills = [...new Set([...skills, ...chainSkills])];
			}
		}

		const outputMode = task.outputMode ?? "inline";
		const model = task.model ?? config.model;
		return { output, outputMode, reads, progress, skills, model };
	});
}
