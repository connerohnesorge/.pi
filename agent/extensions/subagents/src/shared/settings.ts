/**
 * Compatibility facade for chain behavior, instruction rendering, and directory management.
 */

export type {
	ChainStep,
	ParallelStep,
	ParallelTaskItem,
	ResolvedStepBehavior,
	ResolvedTemplates,
	SequentialStep,
	StepOverrides,
} from "./chain-behavior.ts";
export {
	getStepAgents,
	isParallelStep,
	resolveChainTemplates,
	resolveParallelBehaviors,
	resolveStepBehavior,
	suppressProgressForReadOnlyTask,
	taskDisallowsFileUpdates,
} from "./chain-behavior.ts";
export { buildChainInstructions } from "./chain-instructions.ts";
export {
	cleanupOldChainDirs,
	createChainDir,
	createParallelDirs,
	removeChainDir,
	writeInitialProgressFile,
} from "./chain-run-dir.ts";
export type { ParallelTaskResult } from "../runs/shared/parallel-utils.ts";
export { aggregateParallelOutputs } from "../runs/shared/parallel-utils.ts";
