import { matchesCommandPatterns, normalizeCommandForDetection } from "./command-detection.js";
import { compactPath } from "./path-utils.js";

const LINTER_COMMAND_PATTERNS = [
	/^(?:pnpm\s+)?(?:npx\s+)?eslint\b/,
	/^(?:npx\s+)?prettier\b/,
	/^ruff\b/,
	/^pylint\b/,
	/^mypy\b/,
	/^flake8\b/,
	/^black\b/,
	/^cargo\s+clippy\b/,
	/^golangci-lint\b/,
] as const;

const LINTER_TYPE_PATTERNS: Array<[RegExp, string]> = [
	[/(?:^|\s)eslint\b/, "ESLint"],
	[/^ruff\b/, "Ruff"],
	[/^pylint\b/, "Pylint"],
	[/^mypy\b/, "MyPy"],
	[/^flake8\b/, "Flake8"],
	[/clippy\b/, "Clippy"],
	[/^golangci-lint\b/, "GolangCI-Lint"],
	[/prettier\b/, "Prettier"],
];

const FILE_LINE_PATTERN = /^(.+):(\d+):(\d+):\s*(.+)$/;
const RUST_PATTERN = /^(error|warning):\s*(.+?)\s+at\s+(.+):(\d+):(\d+)$/;

interface Issue {
	severity: "ERROR" | "WARNING";
	rule: string;
	file: string;
	line?: number;
	message: string;
}

function isLinterCommand(command: string | undefined | null): boolean {
	return matchesCommandPatterns(command, LINTER_COMMAND_PATTERNS);
}

function lineNumber(value: string | undefined): number | undefined {
	const parsed = Number.parseInt(value ?? "0", 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function issueFromFileLine(match: RegExpMatchArray, fallback: string): Issue {
	const content = match[4] ?? fallback;
	return {
		severity: /warning/i.test(content) ? "WARNING" : "ERROR",
		rule: content.match(/\[(.+?)\]$/)?.[1] ?? "unknown",
		file: match[1] ?? "unknown",
		line: lineNumber(match[2]),
		message: content,
	};
}

function issueFromRust(match: RegExpMatchArray, fallback: string): Issue {
	return {
		severity: (match[1]?.toUpperCase() ?? "ERROR") as "ERROR" | "WARNING",
		rule: "unknown",
		file: match[3] ?? "unknown",
		line: lineNumber(match[4]),
		message: match[2] ?? fallback,
	};
}

function parseLine(line: string): Issue | null {
	const fileLineMatch = line.match(FILE_LINE_PATTERN);
	if (fileLineMatch) return issueFromFileLine(fileLineMatch, line);
	const rustMatch = line.match(RUST_PATTERN);
	return rustMatch ? issueFromRust(rustMatch, line) : null;
}

function parseIssues(output: string): Issue[] {
	return output.split("\n").flatMap((line) => {
		const parsed = parseLine(line);
		return parsed ? [parsed] : [];
	});
}

function detectLinterType(command: string | undefined | null): string {
	const normalized = normalizeCommandForDetection(command);
	return normalized ? (LINTER_TYPE_PATTERNS.find(([pattern]) => pattern.test(normalized))?.[1] ?? "Linter") : "Linter";
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const item of items) counts.set(keyFor(item), (counts.get(keyFor(item)) ?? 0) + 1);
	return counts;
}

function groupByFile(issues: Issue[]): Map<string, Issue[]> {
	const byFile = new Map<string, Issue[]>();
	for (const issue of issues) {
		const existing = byFile.get(issue.file);
		if (existing) existing.push(issue);
		else byFile.set(issue.file, [issue]);
	}
	return byFile;
}

function formatTopRules(byRule: Map<string, number>): string {
	let result = "Top rules:\n";
	const sortedRules = Array.from(byRule.entries()).sort((left, right) => right[1] - left[1]).slice(0, 10);
	for (const [rule, count] of sortedRules) result += `  ${rule} (${count}x)\n`;
	return result;
}

function formatTopFiles(byFile: Map<string, Issue[]>): string {
	let result = "\nTop files:\n";
	const sortedFiles = Array.from(byFile.entries()).sort((left, right) => right[1].length - left[1].length).slice(0, 10);
	for (const [file, fileIssues] of sortedFiles) {
		result += `  ${compactPath(file, 40)} (${fileIssues.length} issues)\n`;
		const topRules = Array.from(countBy(fileIssues, (issue) => issue.rule).entries())
			.sort((left, right) => right[1] - left[1])
			.slice(0, 3);
		for (const [rule, count] of topRules) result += `    ${rule} (${count})\n`;
	}
	return result;
}

export function aggregateLinterOutput(output: string, command: string | undefined | null): string | null {
	if (!isLinterCommand(command)) return null;

	const linterType = detectLinterType(command);
	const issues = parseIssues(output);
	if (issues.length === 0) return `[OK] ${linterType}: No issues found`;

	const byFile = groupByFile(issues);
	const errors = issues.filter((issue) => issue.severity === "ERROR").length;
	const warnings = issues.length - errors;

	let result = `${linterType}: ${errors} errors, ${warnings} warnings in ${byFile.size} files\n`;
	result += "═══════════════════════════════════════\n";
	result += formatTopRules(countBy(issues, (issue) => issue.rule));
	result += formatTopFiles(byFile);
	return result;
}
