import { compactPath } from "./path-utils.js";

interface SearchResult {
	file: string;
	lineNumber: string;
	content: string;
}

const SEARCH_RESULT_PATTERN = /^(.+?):(\d+)?:(.+)$/;

function parseSearchResult(line: string): SearchResult | null {
	if (!line.trim()) return null;
	const match = line.match(SEARCH_RESULT_PATTERN);
	if (!match) return null;
	return {
		file: match[1] ?? "unknown",
		lineNumber: match[2] ?? "?",
		content: match[3] ?? "",
	};
}

function groupByFile(results: SearchResult[]): Map<string, SearchResult[]> {
	const byFile = new Map<string, SearchResult[]>();
	for (const result of results) {
		const matches = byFile.get(result.file);
		if (matches) matches.push(result);
		else byFile.set(result.file, [result]);
	}
	return byFile;
}

function truncateMatchContent(content: string): string {
	const cleaned = content.trim();
	return cleaned.length > 70 ? `${cleaned.slice(0, 67)}...` : cleaned;
}

function formatFileMatches(file: string, matches: SearchResult[]): { text: string; shown: number } {
	let text = `> ${compactPath(file, 50)} (${matches.length} matches):\n`;
	for (const match of matches.slice(0, 10)) {
		text += `    ${match.lineNumber}: ${truncateMatchContent(match.content)}\n`;
	}
	if (matches.length > 10) {
		text += `  +${matches.length - 10} more\n`;
	}
	return { text: `${text}\n`, shown: Math.min(matches.length, 10) };
}

export function groupSearchResults(output: string, maxResults = 50): string | null {
	const results = output.split("\n").flatMap((line) => {
		const parsed = parseSearchResult(line);
		return parsed ? [parsed] : [];
	});
	if (results.length === 0) return null;

	const byFile = groupByFile(results);
	let outputText = `${results.length} matches in ${byFile.size} files:\n\n`;
	let shown = 0;

	for (const [file, matches] of Array.from(byFile.entries()).sort((left, right) => left[0].localeCompare(right[0]))) {
		if (shown >= maxResults) break;
		const formatted = formatFileMatches(file, matches);
		outputText += formatted.text;
		shown += formatted.shown;
	}

	if (results.length > shown) {
		outputText += `... +${results.length - shown} more\n`;
	}
	return outputText;
}
