export type Language =
	| "typescript"
	| "javascript"
	| "python"
	| "rust"
	| "go"
	| "java"
	| "c"
	| "cpp"
	| "unknown";

const LANGUAGE_EXTENSIONS: Record<string, Language> = {
	".ts": "typescript",
	".tsx": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".py": "python",
	".pyw": "python",
	".rs": "rust",
	".go": "go",
	".java": "java",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".hpp": "cpp",
	".cc": "cpp",
};

interface CommentPatterns {
	line?: string;
	blockStart?: string;
	blockEnd?: string;
	docLine?: string;
	docBlockStart?: string;
}

const COMMENT_PATTERNS: Record<Language, CommentPatterns> = {
	typescript: { line: "//", blockStart: "/*", blockEnd: "*/", docBlockStart: "/**" },
	javascript: { line: "//", blockStart: "/*", blockEnd: "*/", docBlockStart: "/**" },
	python: { line: "#", blockStart: '"""', blockEnd: '"""', docBlockStart: '"""' },
	rust: { line: "//", blockStart: "/*", blockEnd: "*/", docLine: "///", docBlockStart: "/**" },
	go: { line: "//", blockStart: "/*", blockEnd: "*/", docBlockStart: "/**" },
	java: { line: "//", blockStart: "/*", blockEnd: "*/", docBlockStart: "/**" },
	c: { line: "//", blockStart: "/*", blockEnd: "*/", docBlockStart: "/**" },
	cpp: { line: "//", blockStart: "/*", blockEnd: "*/", docBlockStart: "/**" },
	unknown: { line: "//", blockStart: "/*", blockEnd: "*/" },
};

const IMPORT_PATTERN = /^(use\s+|import\s+|from\s+|require\(|#include)/;
const SIGNATURE_PATTERN = /^(pub\s+)?(async\s+)?(fn|def|function|func|class|struct|enum|trait|interface|type)\s+\w+/;
const CONST_PATTERN = /^(const|static|let|pub\s+const|pub\s+static)\s+/;
const USERSCRIPT_METADATA_START_PATTERN = /^\/\/\s*==\s*userscript\s*==$/i;
const USERSCRIPT_METADATA_END_PATTERN = /^\/\/\s*==\s*\/userscript\s*==$/i;

interface MinimalFilterState {
	inBlockComment: boolean;
	inDocstring: boolean;
	inUserscriptMetadataBlock: boolean;
}

interface AggressiveFilterState {
	braceDepth: number;
	inImplementation: boolean;
}

export function detectLanguage(filePath: string): Language {
	const lastDot = filePath.lastIndexOf(".");
	if (lastDot === -1) {
		return "unknown";
	}
	const extension = filePath.slice(lastDot).toLowerCase();
	return LANGUAGE_EXTENSIONS[extension] ?? "unknown";
}

function preserveUserscriptMetadata(line: string, trimmed: string, state: MinimalFilterState, result: string[]): boolean {
	if (USERSCRIPT_METADATA_START_PATTERN.test(trimmed)) {
		state.inUserscriptMetadataBlock = true;
		result.push(line);
		return true;
	}

	if (!state.inUserscriptMetadataBlock) {
		return false;
	}

	result.push(line);
	if (USERSCRIPT_METADATA_END_PATTERN.test(trimmed)) {
		state.inUserscriptMetadataBlock = false;
	}
	return true;
}

function hasDelimitedCommentMarkers(patterns: CommentPatterns): boolean {
	return Boolean(patterns.blockStart && patterns.blockEnd);
}

function startsDelimitedComment(trimmed: string, patterns: CommentPatterns, state: MinimalFilterState): boolean {
	return (
		!state.inDocstring &&
		trimmed.includes(patterns.blockStart ?? "\0") &&
		!trimmed.startsWith(patterns.docBlockStart ?? "\0")
	);
}

function updateDelimitedCommentState(trimmed: string, patterns: CommentPatterns, state: MinimalFilterState): boolean {
	const handled = state.inBlockComment || startsDelimitedComment(trimmed, patterns, state);
	state.inBlockComment = handled && !trimmed.includes(patterns.blockEnd ?? "\0");
	return handled;
}

function handleDelimitedComment(trimmed: string, patterns: CommentPatterns, state: MinimalFilterState): boolean {
	return hasDelimitedCommentMarkers(patterns) && updateDelimitedCommentState(trimmed, patterns, state);
}

function handlePythonDocstring(line: string, trimmed: string, language: Language, state: MinimalFilterState, result: string[]): boolean {
	if (language === "python" && trimmed.startsWith('"""')) {
		state.inDocstring = !state.inDocstring;
		result.push(line);
		return true;
	}
	if (!state.inDocstring) return false;
	result.push(line);
	return true;
}

interface MinimalLineContext {
	line: string;
	trimmed: string;
	language: Language;
	patterns: CommentPatterns;
	state: MinimalFilterState;
	result: string[];
}

type MinimalLineHandler = (context: MinimalLineContext) => boolean;

function handleBlockOrDocLine({ line, trimmed, language, patterns, state, result }: MinimalLineContext): boolean {
	return handleDelimitedComment(trimmed, patterns, state) || handlePythonDocstring(line, trimmed, language, state, result);
}

function handleLineComment({ line, trimmed, patterns, result }: MinimalLineContext): boolean {
	if (trimmed.startsWith(patterns.docLine ?? "\0")) result.push(line);
	return trimmed.startsWith(patterns.line ?? "\0");
}

function preserveBlankLine({ trimmed, result }: MinimalLineContext): boolean {
	if (trimmed.length !== 0) return false;
	result.push("");
	return true;
}

function preserveContentLine({ line, result }: MinimalLineContext): boolean {
	result.push(line);
	return true;
}

const MINIMAL_LINE_HANDLERS: MinimalLineHandler[] = [
	({ line, trimmed, state, result }) => preserveUserscriptMetadata(line, trimmed, state, result),
	handleBlockOrDocLine,
	handleLineComment,
	preserveBlankLine,
	preserveContentLine,
];

function filterMinimal(content: string, language: Language): string {
	const patterns = COMMENT_PATTERNS[language];
	const result: string[] = [];
	const state: MinimalFilterState = {
		inBlockComment: false,
		inDocstring: false,
		inUserscriptMetadataBlock: false,
	};

	for (const line of content.split("\n")) {
		const context = { line, trimmed: line.trim(), language, patterns, state, result };
		MINIMAL_LINE_HANDLERS.some((handleLine) => handleLine(context));
	}

	return result
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function countBraces(trimmed: string): number {
	return (trimmed.match(/\{/g) ?? []).length - (trimmed.match(/\}/g) ?? []).length;
}

function shouldKeepImplementationLine(trimmed: string, state: AggressiveFilterState): boolean {
	state.braceDepth += countBraces(trimmed);
	return state.braceDepth <= 1 && (trimmed === "{" || trimmed === "}" || trimmed.endsWith("{"));
}

function finishImplementationIfNeeded(trimmed: string, state: AggressiveFilterState, result: string[]): void {
	if (state.braceDepth > 0) return;
	state.inImplementation = false;
	if (trimmed.length > 0 && trimmed !== "}") result.push("    // ... implementation");
}

function handleAggressiveImplementation(line: string, trimmed: string, state: AggressiveFilterState, result: string[]): boolean {
	if (!state.inImplementation) return false;
	if (shouldKeepImplementationLine(trimmed, state)) result.push(line);
	finishImplementationIfNeeded(trimmed, state, result);
	return true;
}

function filterAggressive(content: string, language: Language): string {
	const result: string[] = [];
	const state: AggressiveFilterState = { braceDepth: 0, inImplementation: false };

	for (const line of filterMinimal(content, language).split("\n")) {
		const trimmed = line.trim();
		if (IMPORT_PATTERN.test(trimmed)) {
			result.push(line);
			continue;
		}
		if (SIGNATURE_PATTERN.test(trimmed)) {
			result.push(line);
			state.inImplementation = true;
			state.braceDepth = 0;
			continue;
		}
		if (handleAggressiveImplementation(line, trimmed, state, result)) continue;
		if (CONST_PATTERN.test(trimmed)) result.push(line);
	}

	return result.join("\n").trim();
}

function isImportantTruncateLine(trimmed: string): boolean {
	return (
		SIGNATURE_PATTERN.test(trimmed) ||
		IMPORT_PATTERN.test(trimmed) ||
		trimmed.startsWith("pub ") ||
		trimmed.startsWith("export ") ||
		trimmed === "}" ||
		trimmed === "{"
	);
}

function pushSkippedSectionNotice(result: string[], totalLines: number, keptLines: number): void {
	result.push(`    // ... ${totalLines - keptLines} lines omitted`);
}

interface TruncateState {
	keptLines: number;
	skippedSection: boolean;
}

function shouldKeepTruncateLine(line: string, keptLines: number, maxLines: number): boolean {
	return isImportantTruncateLine(line.trim()) || keptLines < maxLines / 2;
}

function appendKeptTruncateLine(line: string, totalLines: number, state: TruncateState, result: string[]): void {
	if (state.skippedSection) pushSkippedSectionNotice(result, totalLines, state.keptLines);
	state.skippedSection = false;
	result.push(line);
	state.keptLines += 1;
}

function appendFinalTruncateNotice(result: string[], lines: string[], state: TruncateState): void {
	if (!state.skippedSection && state.keptLines >= lines.length) return;
	result.push(`// ... ${lines.length - state.keptLines} more lines (total: ${lines.length})`);
}

function visitTruncateLine(line: string, lines: string[], maxLines: number, state: TruncateState, result: string[]): void {
	if (shouldKeepTruncateLine(line, state.keptLines, maxLines)) {
		appendKeptTruncateLine(line, lines.length, state, result);
	} else {
		state.skippedSection = true;
	}
}

function appendTruncatedLines(lines: string[], maxLines: number, state: TruncateState, result: string[]): void {
	for (const line of lines) {
		visitTruncateLine(line, lines, maxLines, state, result);
		if (state.keptLines >= maxLines - 1) break;
	}
}

export function smartTruncate(content: string, maxLines: number, _language: Language): string {
	const lines = content.split("\n");
	if (lines.length <= maxLines) return content;

	const result: string[] = [];
	const state: TruncateState = { keptLines: 0, skippedSection: false };
	appendTruncatedLines(lines, maxLines, state, result);
	appendFinalTruncateNotice(result, lines, state);
	return result.join("\n");
}

export function filterSourceCode(
	content: string,
	language: Language,
	level: "none" | "minimal" | "aggressive",
): string {
	switch (level) {
		case "none":
			return content;
		case "minimal":
			return filterMinimal(content, language);
		case "aggressive":
			return filterAggressive(content, language);
		default:
			return content;
	}
}
