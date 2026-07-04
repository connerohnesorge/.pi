import { matchesCommandPatterns, normalizeCommandForDetection } from "./command-detection.js";

const GIT_COMMAND_PATTERNS = [/^git\s+(diff|status|log|show|stash)\b/] as const;
const RAW_GIT_DIFF_PATTERN = /^diff --git /m;
const RAW_GIT_STATUS_PATTERN = /^(?:## |(?:M|A|D|R|C|U|\?| )\S)/m;

function isGitCommand(command: string | undefined | null): boolean {
	return matchesCommandPatterns(command, GIT_COMMAND_PATTERNS);
}

interface DiffCompactionState {
	currentFile: string;
	added: number;
	removed: number;
	inHunk: boolean;
	hunkLines: number;
}

function flushDiffFileSummary(result: string[], state: DiffCompactionState): void {
	if (state.currentFile && (state.added > 0 || state.removed > 0)) {
		result.push(`  +${state.added} -${state.removed}`);
	}
}

function startDiffFile(result: string[], state: DiffCompactionState, line: string): void {
	flushDiffFileSummary(result, state);

	const match = line.match(/diff --git a\/(.+) b\/(.+)/);
	state.currentFile = match?.[2] ?? "unknown";
	result.push(`\n> ${state.currentFile}`);
	state.added = 0;
	state.removed = 0;
	state.inHunk = false;
}

function appendLimitedHunkLine(result: string[], state: DiffCompactionState, line: string, maxHunkLines: number): void {
	if (state.hunkLines < maxHunkLines) {
		result.push(`  ${line}`);
		state.hunkLines++;
	}

	if (state.hunkLines === maxHunkLines) {
		result.push("  ... (truncated)");
		state.hunkLines++;
	}
}

function appendDiffHunkLine(result: string[], state: DiffCompactionState, line: string, maxHunkLines: number): void {
	if (line.startsWith("+") && !line.startsWith("+++")) {
		state.added++;
		appendLimitedHunkLine(result, state, line, maxHunkLines);
	} else if (line.startsWith("-") && !line.startsWith("---")) {
		state.removed++;
		appendLimitedHunkLine(result, state, line, maxHunkLines);
	} else if (state.hunkLines > 0 && !line.startsWith("\\")) {
		appendLimitedHunkLine(result, state, line, maxHunkLines);
	}
}

function startDiffHunk(result: string[], state: DiffCompactionState, line: string): void {
	state.inHunk = true;
	state.hunkLines = 0;
	const hunkInfo = line.match(/@@ .+ @@/)?.[0] ?? "@@";
	result.push(`  ${hunkInfo}`);
}

interface DiffLineHandler {
	matches(line: string, state: DiffCompactionState): boolean;
	append(result: string[], state: DiffCompactionState, line: string, maxHunkLines: number): void;
}

const DIFF_LINE_HANDLERS: DiffLineHandler[] = [
	{
		matches: (line) => line.startsWith("diff --git"),
		append: startDiffFile,
	},
	{
		matches: (line) => line.startsWith("@@"),
		append: startDiffHunk,
	},
	{
		matches: (_line, state) => state.inHunk,
		append: appendDiffHunkLine,
	},
];

function appendMatchingDiffLine(result: string[], state: DiffCompactionState, line: string, maxHunkLines: number): void {
	DIFF_LINE_HANDLERS.find((handler) => handler.matches(line, state))?.append(result, state, line, maxHunkLines);
}

function compactDiff(output: string, maxLines = 50): string {
	const lines = output.split("\n");
	const result: string[] = [];
	const state: DiffCompactionState = { currentFile: "", added: 0, removed: 0, inHunk: false, hunkLines: 0 };
	const maxHunkLines = 10;

	for (const line of lines) {
		if (result.length >= maxLines) {
			result.push("\n... (more changes truncated)");
			break;
		}

		appendMatchingDiffLine(result, state, line, maxHunkLines);
	}

	flushDiffFileSummary(result, state);

	return result.join("\n");
}

interface StatusStats {
	staged: number;
	modified: number;
	untracked: number;
	conflicts: number;
	stagedFiles: string[];
	modifiedFiles: string[];
	untrackedFiles: string[];
}

const STAGED_STATUS = ["M", "A", "D", "R", "C"];
const MODIFIED_STATUS = ["M", "D"];

function parseStatusBranch(line: string): string | null {
	const shortBranch = line.match(/^## (.+)/)?.[1];
	if (shortBranch) {
		return shortBranch.split("...")[0] ?? shortBranch;
	}

	return line.match(/^# branch\.head (.+)/)?.[1] ?? null;
}

function accumulateStatusLine(stats: StatusStats, line: string): void {
	if (line.length < 3) {
		return;
	}

	const status = line.slice(0, 2);
	const filename = line.slice(3);
	const indexStatus = status[0];
	const worktreeStatus = status[1];

	if (STAGED_STATUS.includes(indexStatus)) {
		stats.staged++;
		stats.stagedFiles.push(filename);
	}

	if (indexStatus === "U") {
		stats.conflicts++;
	}

	if (MODIFIED_STATUS.includes(worktreeStatus)) {
		stats.modified++;
		stats.modifiedFiles.push(filename);
	}

	if (status === "??") {
		stats.untracked++;
		stats.untrackedFiles.push(filename);
	}
}

function appendFileList(result: string, label: string, count: number, files: string[], limit: number): string {
	if (count === 0) {
		return result;
	}

	result += `${label}: ${count} files\n`;
	for (const file of files.slice(0, limit)) {
		result += `  ${file}\n`;
	}
	if (count > limit) {
		result += `  ... +${count - limit} more\n`;
	}
	return result;
}

function compactStatus(output: string): string {
	const lines = output.split("\n");

	if (lines.length === 0 || (lines.length === 1 && lines[0]?.trim() === "")) {
		return "Clean working tree";
	}

	const stats: StatusStats = {
		staged: 0,
		modified: 0,
		untracked: 0,
		conflicts: 0,
		stagedFiles: [],
		modifiedFiles: [],
		untrackedFiles: [],
	};

	let branchName = "";

	for (const line of lines) {
		const parsedBranch = parseStatusBranch(line);
		if (parsedBranch !== null) {
			branchName = parsedBranch;
			continue;
		}

		accumulateStatusLine(stats, line);
	}

	let result = `Branch: ${branchName}\n`;
	result = appendFileList(result, "Staged", stats.staged, stats.stagedFiles, 5);
	result = appendFileList(result, "Modified", stats.modified, stats.modifiedFiles, 5);
	result = appendFileList(result, "Untracked", stats.untracked, stats.untrackedFiles, 3);

	if (stats.conflicts > 0) {
		result += `Conflicts: ${stats.conflicts} files\n`;
	}

	return result.trim();
}

function compactLog(output: string, limit = 20): string {
	const lines = output.split("\n");
	const result: string[] = [];

	for (const line of lines.slice(0, limit)) {
		if (line.length > 80) {
			result.push(`${line.slice(0, 77)}...`);
		} else {
			result.push(line);
		}
	}

	if (lines.length > limit) {
		result.push(`... and ${lines.length - limit} more commits`);
	}

	return result.join("\n");
}

interface GitCompactor {
	matches(command: string): boolean;
	compact(output: string): string | null;
}

const GIT_COMPACTORS: GitCompactor[] = [
	{
		matches: (command) => command.startsWith("git diff"),
		compact: (output) => (RAW_GIT_DIFF_PATTERN.test(output) ? compactDiff(output) : null),
	},
	{
		matches: (command) => command.startsWith("git status"),
		compact: (output) => (RAW_GIT_STATUS_PATTERN.test(output) ? compactStatus(output) : null),
	},
	{
		matches: (command) => command.startsWith("git log"),
		compact: compactLog,
	},
];

export function compactGitOutput(output: string, command: string | undefined | null): string | null {
	if (!isGitCommand(command)) {
		return null;
	}

	const normalized = normalizeCommandForDetection(command);
	return normalized ? (GIT_COMPACTORS.find((compactor) => compactor.matches(normalized))?.compact(output) ?? null) : null;
}
