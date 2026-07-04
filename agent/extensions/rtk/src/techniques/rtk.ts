const RTK_HOOK_WARNING_MESSAGES = [
	"No hook installed — run `rtk init -g` for automatic token savings",
	"Hook outdated — run `rtk init -g` to update",
] as const;

const RTK_HOOK_WARNING_PREFIX_MARKERS = ["[rtk] /!\\", "⚠", "[WARN]"] as const;

type HookWarningLineStripResult =
	| {
			removed: false;
			removedLine: false;
			line: string;
	  }
	| {
			removed: true;
			removedLine: boolean;
			line: string;
	  };

function outputContainsKnownHookWarning(output: string): boolean {
	return RTK_HOOK_WARNING_MESSAGES.some((message) => output.includes(message));
}

function isQuotedPrefixBoundary(line: string, prefixIndex: number): boolean {
	if (prefixIndex <= 0) {
		return false;
	}

	const charBefore = line[prefixIndex - 1];
	return charBefore === "\"" || charBefore === "'";
}

function findClosestWarningPrefixIndex(line: string, beforeIndex: number): number {
	let closestIndex = -1;
	for (const marker of RTK_HOOK_WARNING_PREFIX_MARKERS) {
		const index = line.lastIndexOf(marker, beforeIndex);
		if (index > closestIndex) {
			closestIndex = index;
		}
	}

	return closestIndex;
}

function findHookWarningMatch(line: string): { message: string; messageIndex: number; prefixIndex: number } | null {
	for (const message of RTK_HOOK_WARNING_MESSAGES) {
		const messageIndex = line.indexOf(message);
		const prefixIndex = messageIndex === -1 ? -1 : findClosestWarningPrefixIndex(line, messageIndex);
		if (prefixIndex !== -1 && !isQuotedPrefixBoundary(line, prefixIndex)) {
			return { message, messageIndex, prefixIndex };
		}
	}
	return null;
}

function findRemovalStart(line: string, prefixIndex: number): number {
	let removalStart = prefixIndex;
	while (removalStart > 0 && /\s/.test(line[removalStart - 1] ?? "")) {
		removalStart -= 1;
	}
	return removalStart;
}

function removeWarningMatch(line: string, message: string, messageIndex: number, prefixIndex: number): string {
	const before = line.slice(0, findRemovalStart(line, prefixIndex));
	const after = line.slice(messageIndex + message.length);
	return before.trim() && after.trim() ? `${before.trimEnd()}\n${after}` : `${before}${after}`;
}

function stripHookWarningFromLine(line: string): HookWarningLineStripResult {
	const trimmed = line.trim();
	if (!trimmed) {
		return { removed: false, removedLine: false, line };
	}
	if (RTK_HOOK_WARNING_MESSAGES.some((message) => trimmed === message)) {
		return { removed: true, removedLine: true, line: "" };
	}

	const match = findHookWarningMatch(line);
	if (!match) {
		return { removed: false, removedLine: false, line };
	}

	const nextLine = removeWarningMatch(line, match.message, match.messageIndex, match.prefixIndex);
	return { removed: true, removedLine: !nextLine.trim(), line: nextLine.trim() ? nextLine : "" };
}

function stripHookWarningLines(output: string): { lines: string[]; removedWarning: boolean } {
	const lines: string[] = [];
	let removedWarning = false;
	let skipImmediateBlankLine = false;

	for (const line of output.split("\n")) {
		if (skipImmediateBlankLine && line.trim() === "") {
			skipImmediateBlankLine = false;
			continue;
		}

		const stripped = stripHookWarningFromLine(line);
		removedWarning ||= stripped.removed;
		skipImmediateBlankLine = stripped.removedLine;
		if (!stripped.removedLine) {
			lines.push(stripped.line);
		}
	}

	return { lines, removedWarning };
}

function trimLeadingBlankLines(lines: string[]): string[] {
	while (lines.length > 0 && lines[0]?.trim() === "") {
		lines.shift();
	}
	return lines;
}

/**
 * Removes only RTK hook status notices that are not actionable inside Pi.
 * Other RTK warnings should remain visible so the agent can inspect them.
 */
export function stripRtkHookWarnings(output: string, _command: string | undefined | null): string | null {
	if (!outputContainsKnownHookWarning(output)) {
		return null;
	}

	const stripped = stripHookWarningLines(output);
	return stripped.removedWarning ? trimLeadingBlankLines(stripped.lines).join("\n") : null;
}
