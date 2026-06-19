import * as path from "node:path";
import type { ResolvedStepBehavior } from "./chain-behavior.ts";

/**
 * Resolve a file path: absolute paths pass through, relative paths get chainDir prepended.
 */
function resolveChainPath(filePath: string, chainDir: string): string {
	return path.isAbsolute(filePath) ? filePath : path.join(chainDir, filePath);
}

/**
 * Build chain instructions from resolved behavior.
 * These are appended to the task to tell the agent what to read/write.
 */
export function buildChainInstructions(
	behavior: ResolvedStepBehavior,
	chainDir: string,
	isFirstProgressAgent: boolean,
	previousSummary?: string,
): { prefix: string; suffix: string } {
	const prefixParts: string[] = [];
	const suffixParts: string[] = [];

	// READS - prepend to override any hardcoded filenames in task text
	if (behavior.reads && behavior.reads.length > 0) {
		const files = behavior.reads.map((f) => resolveChainPath(f, chainDir));
		prefixParts.push(`[Read from: ${files.join(", ")}]`);
	}

	// OUTPUT - prepend so agent knows where to write
	if (behavior.output) {
		const outputPath = resolveChainPath(behavior.output, chainDir);
		prefixParts.push(`[Write to: ${outputPath}]`);
	}

	// Progress instructions in suffix (less critical)
	if (behavior.progress) {
		const progressPath = path.join(chainDir, "progress.md");
		if (isFirstProgressAgent) {
			suffixParts.push(`Create and maintain progress at: ${progressPath}`);
		} else {
			suffixParts.push(`Update progress at: ${progressPath}`);
		}
	}

	// Include previous step's summary in suffix if available
	if (previousSummary && previousSummary.trim()) {
		suffixParts.push(`Previous step output:\n${previousSummary.trim()}`);
	}

	const prefix = prefixParts.length > 0
		? prefixParts.join("\n") + "\n\n"
		: "";

	const suffix = suffixParts.length > 0
		? "\n\n---\n" + suffixParts.join("\n")
		: "";

	return { prefix, suffix };
}
