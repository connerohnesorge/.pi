import { matchesCommandPatterns } from "./command-detection.js";

interface TestSummary {
	passed: number;
	failed: number;
	skipped: number;
	failures: string[];
}

const TEST_COMMAND_PATTERNS = [
	/^npm\s+test\b/,
	/^pnpm\s+test\b/,
	/^yarn\s+test\b/,
	/^bun\s+test\b/,
	/^cargo\s+test\b/,
	/^go\s+test\b/,
	/^pytest\b/,
	/^python\s+-m\s+pytest\b/,
	/^(?:pnpm\s+)?(?:npx\s+)?vitest\b/,
	/^(?:npx\s+)?jest\b/,
	/^mocha\b/,
	/^ava\b/,
	/^tap\b/,
] as const;

const TEST_RESULT_PATTERNS = [
	/test result:\s*(\w+)\.\s*(\d+)\s*passed;\s*(\d+)\s*failed;/,
	/(\d+)\s*passed(?:,\s*(\d+)\s*failed)?(?:,\s*(\d+)\s*skipped)?/i,
	/(\d+)\s*pass(?:,\s*(\d+)\s*fail)?(?:,\s*(\d+)\s*skip)?/i,
	/tests?:\s*(\d+)\s*passed(?:,\s*(\d+)\s*failed)?(?:,\s*(\d+)\s*skipped)?/i,
];

const FAILURE_START_PATTERNS = [
	/^FAIL\s+/,
	/^FAILED\s+/,
	/^\s*●\s+/,
	/^\s*✕\s+/,
	/test\s+\w+\s+\.\.\.\s*FAILED/,
	/thread\s+'\w+'\s+panicked/,
];

function isFailureStart(line: string): boolean {
	return FAILURE_START_PATTERNS.some((pattern) => pattern.test(line));
}

function extractTestStats(output: string): Partial<TestSummary> {
	for (const pattern of TEST_RESULT_PATTERNS) {
		const match = output.match(pattern);
		if (!match) {
			continue;
		}
		return {
			passed: Number.parseInt(match[1] ?? "0", 10) || 0,
			failed: Number.parseInt(match[2] ?? "0", 10) || 0,
			skipped: Number.parseInt(match[3] ?? "0", 10) || 0,
		};
	}
	return {};
}

function isTestCommand(command: string | undefined | null): boolean {
	return matchesCommandPatterns(command, TEST_COMMAND_PATTERNS);
}

function countFallbackStats(lines: string[]): Pick<TestSummary, "passed" | "failed"> {
	const stats = { passed: 0, failed: 0 };
	for (const line of lines) {
		if (line.match(/\b(ok|PASS|✓|✔)\b/)) {
			stats.passed++;
		}
		if (line.match(/\b(FAIL|fail|✗|✕)\b/)) {
			stats.failed++;
		}
	}
	return stats;
}

interface FailureState {
	failures: string[];
	inFailure: boolean;
	currentFailure: string[];
	blankCount: number;
}

function closeFailure(state: FailureState): void {
	if (state.currentFailure.length > 0) {
		state.failures.push(state.currentFailure.join("\n"));
	}
	state.inFailure = false;
	state.currentFailure = [];
}

function startFailure(state: FailureState, line: string): void {
	if (state.inFailure) {
		closeFailure(state);
	}
	state.inFailure = true;
	state.currentFailure = [line];
	state.blankCount = 0;
}

function handleBlankFailureLine(state: FailureState, line: string): void {
	state.blankCount++;
	if (state.blankCount >= 2 && state.currentFailure.length > 3) {
		closeFailure(state);
	} else {
		state.currentFailure.push(line);
	}
}

function isFailureDetailLine(line: string): boolean {
	return line.match(/^\s/) !== null || line.match(/^-/) !== null;
}

function extractFailureBlocks(lines: string[]): string[] {
	const state: FailureState = { failures: [], inFailure: false, currentFailure: [], blankCount: 0 };

	for (const line of lines) {
		if (isFailureStart(line)) {
			startFailure(state, line);
			continue;
		}
		if (!state.inFailure) {
			continue;
		}
		if (line.trim() === "") {
			handleBlankFailureLine(state, line);
			continue;
		}
		if (isFailureDetailLine(line)) {
			state.currentFailure.push(line);
			state.blankCount = 0;
			continue;
		}
		closeFailure(state);
	}

	if (state.inFailure) {
		closeFailure(state);
	}

	return state.failures;
}

function clippedLine(line: string, length: number): string {
	return `${line.slice(0, length)}${line.length > length ? "..." : ""}`;
}

function appendFailureDetails(result: string[], failureLines: string[]): void {
	for (const detailLine of failureLines.slice(1, 4)) {
		if (detailLine.trim()) {
			result.push(`     ${clippedLine(detailLine, 65)}`);
		}
	}
	if (failureLines.length > 4) {
		result.push(`     ... (${failureLines.length - 4} more lines)`);
	}
}

function appendFailureSummary(result: string[], failures: string[]): void {
	result.push("\n   Failures:");
	for (const failure of failures.slice(0, 5)) {
		const failureLines = failure.split("\n");
		result.push(`   - ${clippedLine(failureLines[0] ?? "", 70)}`);
		appendFailureDetails(result, failureLines);
	}
	if (failures.length > 5) {
		result.push(`   ... and ${failures.length - 5} more failures`);
	}
}

function renderTestSummary(summary: TestSummary): string {
	const result: string[] = ["Test Results:"];
	result.push(`   PASS: ${summary.passed} passed`);
	if (summary.failed > 0) {
		result.push(`   FAIL: ${summary.failed} failed`);
	}
	if (summary.skipped > 0) {
		result.push(`   SKIP: ${summary.skipped} skipped`);
	}

	if (summary.failed > 0 && summary.failures.length > 0) {
		appendFailureSummary(result, summary.failures);
	}

	return result.join("\n");
}

export function aggregateTestOutput(output: string, command: string | undefined | null): string | null {
	if (!isTestCommand(command)) {
		return null;
	}

	const lines = output.split("\n");
	const stats = extractTestStats(output);
	const summary: TestSummary = {
		passed: stats.passed ?? 0,
		failed: stats.failed ?? 0,
		skipped: stats.skipped ?? 0,
		failures: [],
	};

	if (summary.passed === 0 && summary.failed === 0) {
		Object.assign(summary, countFallbackStats(lines));
	}

	if (summary.failed > 0) {
		summary.failures = extractFailureBlocks(lines);
	}

	return renderTestSummary(summary);
}
