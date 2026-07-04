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

function handleBlockOrDocLine(
	line: string,
	trimmed: string,
	language: Language,
	patterns: CommentPatterns,
	state: MinimalFilterState,
	result: string[],
): boolean {
	if (patterns.blockStart && patterns.blockEnd) {
		if (
			!state.inDocstring &&
			trimmed.includes(patterns.blockStart) &&
			!(patterns.docBlockStart && trimmed.startsWith(patterns.docBlockStart))
		) {
			state.inBlockComment = true;
		}

		if (state.inBlockComment) {
			if (trimmed.includes(patterns.blockEnd)) {
				state.inBlockComment = false;
			}
			return true;
		}
	}

	if (language === "python" && trimmed.startsWith('"""')) {
		state.inDocstring = !state.inDocstring;
		result.push(line);
		return true;
	}

	if (state.inDocstring) {
		result.push(line);
		return true;
	}

	return false;
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

function filterAggressive(content: string, language: Language): string {
	const minimal = filterMinimal(content, language);
	const lines = minimal.split("\n");
	const result: string[] = [];
	let braceDepth = 0;
	let inImplementation = false;

	for (const line of lines) {
		const trimmed = line.trim();

		if (IMPORT_PATTERN.test(trimmed)) {
			result.push(line);
			continue;
		}

		if (SIGNATURE_PATTERN.test(trimmed)) {
			result.push(line);
			inImplementation = true;
			braceDepth = 0;
			continue;
		}

		const openBraces = (trimmed.match(/\{/g) ?? []).length;
		const closeBraces = (trimmed.match(/\}/g) ?? []).length;

		if (inImplementation) {
			braceDepth += openBraces;
			braceDepth -= closeBraces;

			if (braceDepth <= 1 && (trimmed === "{" || trimmed === "}" || trimmed.endsWith("{"))) {
				result.push(line);
			}

			if (braceDepth <= 0) {
				inImplementation = false;
				if (trimmed.length > 0 && trimmed !== "}") {
					result.push("    // ... implementation");
				}
			}
			continue;
		}

		if (CONST_PATTERN.test(trimmed)) {
			result.push(line);
		}
	}

	return result.join("\n").trim();
}

export function smartTruncate(content: string, maxLines: number, _language: Language): string {
	const lines = content.split("\n");
	if (lines.length <= maxLines) {
		return content;
	}

	const result: string[] = [];
	let keptLines = 0;
	let skippedSection = false;

	for (const line of lines) {
		const trimmed = line.trim();
		const isImportant =
			SIGNATURE_PATTERN.test(trimmed) ||
			IMPORT_PATTERN.test(trimmed) ||
			trimmed.startsWith("pub ") ||
			trimmed.startsWith("export ") ||
			trimmed === "}" ||
			trimmed === "{";

		if (isImportant || keptLines < maxLines / 2) {
			if (skippedSection) {
				result.push(`    // ... ${lines.length - keptLines} lines omitted`);
				skippedSection = false;
			}
			result.push(line);
			keptLines += 1;
		} else {
			skippedSection = true;
		}

		if (keptLines >= maxLines - 1) {
			break;
		}
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
