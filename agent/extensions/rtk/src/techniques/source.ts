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

function handleDelimitedComment(trimmed: string, patterns: CommentPatterns, state: MinimalFilterState): boolean {
	if (!patterns.blockStart || !patterns.blockEnd) return false;
	if (!state.inDocstring && trimmed.includes(patterns.blockStart) && !trimmed.startsWith(patterns.docBlockStart ?? "\0")) {
		state.inBlockComment = true;
	}
	if (!state.inBlockComment) return false;
	if (trimmed.includes(patterns.blockEnd)) state.inBlockComment = false;
	return true;
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

function handleBlockOrDocLine(
	line: string,
	trimmed: string,
	language: Language,
	patterns: CommentPatterns,
	state: MinimalFilterState,
	result: string[],
): boolean {
	return handleDelimitedComment(trimmed, patterns, state) || handlePythonDocstring(line, trimmed, language, state, result);
}

function filterMinimal(content: string, language: Language): string {
	const patterns = COMMENT_PATTERNS[language];
	const lines = content.split("\n");
	const result: string[] = [];
	const state: MinimalFilterState = {
		inBlockComment: false,
		inDocstring: false,
		inUserscriptMetadataBlock: false,
	};

	for (const line of lines) {
		const trimmed = line.trim();

		if (preserveUserscriptMetadata(line, trimmed, state, result)) {
			continue;
		}

		if (handleBlockOrDocLine(line, trimmed, language, patterns, state, result)) {
			continue;
		}

		if (patterns.line && trimmed.startsWith(patterns.line)) {
			if (patterns.docLine && trimmed.startsWith(patterns.docLine)) {
				result.push(line);
			}
			continue;
		}

		if (trimmed.length === 0) {
			result.push("");
			continue;
		}

		result.push(line);
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

export function smartTruncate(content: string, maxLines: number, _language: Language): string {
	const lines = content.split("\n");
	if (lines.length <= maxLines) return content;

	const result: string[] = [];
	let keptLines = 0;
	let skippedSection = false;

	for (const line of lines) {
		if (isImportantTruncateLine(line.trim()) || keptLines < maxLines / 2) {
			if (skippedSection) pushSkippedSectionNotice(result, lines.length, keptLines);
			skippedSection = false;
			result.push(line);
			keptLines += 1;
		} else {
			skippedSection = true;
		}
		if (keptLines >= maxLines - 1) break;
	}

	if (skippedSection || keptLines < lines.length) {
		result.push(`// ... ${lines.length - keptLines} more lines (total: ${lines.length})`);
	}
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
