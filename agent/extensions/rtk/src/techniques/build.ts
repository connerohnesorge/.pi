import { matchesCommandPatterns } from "./command-detection.js";

interface BuildStats {
	compiled: number;
	errors: string[][];
	warnings: string[];
}

interface ErrorBlockState {
	inBlock: boolean;
	current: string[];
	blankCount: number;
}

const BUILD_COMMAND_PATTERNS = [
	/^cargo\s+(build|check)\b/,
	/^bun\s+build\b/,
	/^npm\s+run\s+build\b/,
	/^yarn\s+build\b/,
	/^pnpm\s+build\b/,
	/^(?:npx\s+)?tsc\b/,
	/^make\b/,
	/^cmake\b/,
	/^gradle\b/,
	/^mvn\b/,
	/^go\s+(build|install)\b/,
	/^python\s+setup\.py\s+build\b/,
	/^pip\s+install\b/,
] as const;

const SKIP_PATTERNS = [
	/^\s*Compiling\s+/,
	/^\s*Checking\s+/,
	/^\s*Downloading\s+/,
	/^\s*Downloaded\s+/,
	/^\s*Fetching\s+/,
	/^\s*Fetched\s+/,
	/^\s*Updating\s+/,
	/^\s*Updated\s+/,
	/^\s*Building\s+/,
	/^\s*Generated\s+/,
	/^\s*Creating\s+/,
	/^\s*Running\s+/,
];

const ERROR_START_PATTERNS = [/^error\[/, /^error:/, /^\[ERROR\]/, /^FAIL/];
const WARNING_PATTERNS = [/^warning:/, /^\[WARNING\]/, /^warn:/];

function isSkipLine(line: string): boolean {
	return SKIP_PATTERNS.some((pattern) => pattern.test(line));
}

function isErrorStart(line: string): boolean {
	return ERROR_START_PATTERNS.some((pattern) => pattern.test(line));
}

function isWarning(line: string): boolean {
	return WARNING_PATTERNS.some((pattern) => pattern.test(line));
}

function isBuildCommand(command: string | undefined | null): boolean {
	return matchesCommandPatterns(command, BUILD_COMMAND_PATTERNS);
}

function flushErrorBlock(stats: BuildStats, state: ErrorBlockState): void {
	if (state.current.length > 0) {
		stats.errors.push([...state.current]);
	}
	state.inBlock = false;
	state.current = [];
	state.blankCount = 0;
}

function startErrorBlock(stats: BuildStats, state: ErrorBlockState, line: string): void {
	if (state.inBlock) {
		flushErrorBlock(stats, state);
	}
	state.inBlock = true;
	state.current = [line];
	state.blankCount = 0;
}

function handleErrorBlockLine(stats: BuildStats, state: ErrorBlockState, line: string): void {
	if (!state.inBlock) {
		return;
	}

	if (line.trim() === "") {
		state.blankCount++;
		if (state.blankCount >= 2 && state.current.length > 3) {
			flushErrorBlock(stats, state);
		} else {
			state.current.push(line);
		}
		return;
	}

	if (line.match(/^\s/) || line.match(/^-->/)) {
		state.current.push(line);
		state.blankCount = 0;
		return;
	}

	flushErrorBlock(stats, state);
}

function collectBuildStats(lines: string[]): BuildStats {
	const stats: BuildStats = {
		compiled: 0,
		errors: [],
		warnings: [],
	};
	const errorBlock: ErrorBlockState = { inBlock: false, current: [], blankCount: 0 };

	for (const line of lines) {
		if (line.match(/^\s*(Compiling|Checking|Building)\s+/)) {
			stats.compiled++;
			continue;
		}

		if (isSkipLine(line)) {
			continue;
		}

		if (isErrorStart(line)) {
			startErrorBlock(stats, errorBlock, line);
			continue;
		}

		if (isWarning(line)) {
			stats.warnings.push(line);
			continue;
		}

		handleErrorBlockLine(stats, errorBlock, line);
	}

	flushErrorBlock(stats, errorBlock);
	return stats;
}

function formatBuildError(error: string[]): string[] {
	return error.length > 10 ? [...error.slice(0, 10), "  ..."] : error.slice(0, 10);
}

function remainingErrorSummary(errors: string[][]): string[] {
	return errors.length > 5 ? [`... and ${errors.length - 5} more errors`] : [];
}

function appendBuildErrors(result: string[], errors: string[][]): void {
	if (errors.length > 0) {
		result.push(
			`[ERROR] ${errors.length} error(s):`,
			...errors.slice(0, 5).flatMap(formatBuildError),
			...remainingErrorSummary(errors),
		);
	}
}

function appendBuildWarnings(result: string[], warnings: string[]): void {
	if (warnings.length > 0) {
		result.push(`\n[WARN] ${warnings.length} warning(s)`);
	}
}

export function filterBuildOutput(output: string, command: string | undefined | null): string | null {
	if (!isBuildCommand(command)) {
		return null;
	}

	const stats = collectBuildStats(output.split("\n"));

	if (stats.errors.length === 0 && stats.warnings.length === 0) {
		return `[OK] Build successful (${stats.compiled} units compiled)`;
	}

	const result: string[] = [];
	appendBuildErrors(result, stats.errors);
	appendBuildWarnings(result, stats.warnings);
	return result.join("\n");
}
