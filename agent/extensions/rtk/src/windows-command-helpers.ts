interface WindowsBashCompatibilityResult {
	command: string;
	applied: string[];
}

interface LeadingCdSlashDParse {
	rawPath: string;
	operator: string;
	tail: string;
}

interface CdSlashDScanState {
	quote: '"' | "'" | null;
	escaped: boolean;
}

const PYTHON_UTF8_ENV_PREFIX = "PYTHONIOENCODING=utf-8";

function normalizeWindowsPathForBash(rawPath: string): string {
	const trimmed = rawPath.trim();
	const unquoted =
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
			? trimmed.slice(1, -1)
			: trimmed;
	return unquoted.replace(/\\/g, "/");
}

function quoteForBash(value: string): string {
	const escaped = value.replace(/"/g, '\\"');
	return `"${escaped}"`;
}

function advanceCdSlashDScanner(state: CdSlashDScanState, character: string): boolean {
	if (state.escaped) {
		state.escaped = false;
		return true;
	}

	if (state.quote !== null) {
		if (character === "\\" && state.quote !== "'") {
			state.escaped = true;
		} else if (character === state.quote) {
			state.quote = null;
		}
		return true;
	}

	if (character === "\\") {
		state.escaped = true;
		return true;
	}

	if (character === '"' || character === "'") {
		state.quote = character;
		return true;
	}

	return false;
}

function readCdSlashDOperator(command: string, index: number): { operator: string; tailStart: number } | null {
	const pair = command.slice(index, index + 2);
	if (pair === "&&" || pair === "||") {
		return { operator: pair, tailStart: index + 2 };
	}

	const character = command[index] ?? "";
	if (character === "|" || character === ";") {
		return { operator: character, tailStart: index + 1 };
	}

	return null;
}

function parseLeadingCdSlashD(command: string): LeadingCdSlashDParse | null {
	const prefixMatch = command.match(/^\s*cd\s+\/d\s+/i);
	if (!prefixMatch) {
		return null;
	}

	const pathStart = prefixMatch[0].length;
	const state: CdSlashDScanState = { quote: null, escaped: false };

	for (let index = pathStart; index < command.length; index += 1) {
		const character = command[index] ?? "";
		if (advanceCdSlashDScanner(state, character)) {
			continue;
		}

		const parsedOperator = readCdSlashDOperator(command, index);
		if (parsedOperator) {
			return {
				rawPath: command.slice(pathStart, index),
				operator: parsedOperator.operator,
				tail: command.slice(parsedOperator.tailStart),
			};
		}
	}

	return {
		rawPath: command.slice(pathStart),
		operator: "",
		tail: "",
	};
}

function rewriteLeadingCdSlashD(command: string): { command: string; changed: boolean } {
	const parsed = parseLeadingCdSlashD(command);
	if (!parsed) {
		return { command, changed: false };
	}

	const normalizedPath = quoteForBash(normalizeWindowsPathForBash(parsed.rawPath));
	if (!parsed.operator) {
		return {
			command: `cd ${normalizedPath}`,
			changed: true,
		};
	}

	return {
		command: `cd ${normalizedPath} ${parsed.operator} ${parsed.tail.trimStart()}`,
		changed: true,
	};
}

function ensurePythonUtf8(command: string): { command: string; changed: boolean } {
	if (/\bPYTHONIOENCODING\s*=/.test(command)) {
		return { command, changed: false };
	}

	if (!/(^|[;&|]\s*|&&\s*|\|\|\s*)python(?:3(?:\.\d+)?)?\b/i.test(command)) {
		return { command, changed: false };
	}

	return {
		command: `${PYTHON_UTF8_ENV_PREFIX} ${command}`,
		changed: true,
	};
}

export function applyWindowsBashCompatibilityFixes(
	command: string,
	platform: string = process.platform,
): WindowsBashCompatibilityResult {
	if (platform !== "win32") {
		return { command, applied: [] };
	}

	let nextCommand = command;
	const applied: string[] = [];

	const cdFix = rewriteLeadingCdSlashD(nextCommand);
	if (cdFix.changed) {
		nextCommand = cdFix.command;
		applied.push("cd-/d");
	}

	const pythonFix = ensurePythonUtf8(nextCommand);
	if (pythonFix.changed) {
		nextCommand = pythonFix.command;
		applied.push("python-utf8");
	}

	return { command: nextCommand, applied };
}
