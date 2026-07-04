import { splitLeadingEnvAssignments } from "./shell-env-prefix.js";

interface ParsedPipeline {
	segments: string[];
	separators: string[];
	suffix: string;
}

interface ProducerRewritePlan {
	command: string;
	captureStderr: boolean;
}

interface ShellSafetyTarget {
	environmentPrelude: string;
	command: string;
}

const SINGLE_QUOTED_SHELL_VALUE_PATTERN = "'(?:'\\\\''|[^'])*'";
const SHELL_ENV_VALUE_PATTERN = `(?:"(?:\\\\.|[^"])*"|${SINGLE_QUOTED_SHELL_VALUE_PATTERN}|[^\\s;]+)`;
const LEADING_RTK_DB_PATH_EXPORT_PRELUDE_PATTERN = new RegExp(
	`^(\\s*export\\s+RTK_DB_PATH=${SHELL_ENV_VALUE_PATTERN}\\s*;\\s*)([\\s\\S]*)$`,
	"u",
);

function splitLeadingRtkDbPathExportPrelude(command: string): ShellSafetyTarget {
	const match = command.match(LEADING_RTK_DB_PATH_EXPORT_PRELUDE_PATTERN);
	if (!match) {
		return { environmentPrelude: "", command };
	}

	return {
		environmentPrelude: match[1] ?? "",
		command: match[2] ?? "",
	};
}

function isTopLevelQuoteCharacter(character: string): character is '"' | "'" | "`" {
	return character === '"' || character === "'" || character === "`";
}

interface PipelineParserState {
	quote: '"' | "'" | "`" | null;
	escaped: boolean;
	segmentStart: number;
	suffix: string;
}

function consumeQuotedOrEscapedCharacter(state: PipelineParserState, character: string): boolean {
	if (state.escaped) {
		state.escaped = false;
		return true;
	}

	if (state.quote !== null) {
		if (character === "\\" && state.quote !== "'") {
			state.escaped = true;
			return true;
		}
		if (character === state.quote) {
			state.quote = null;
		}
		return true;
	}

	if (character === "\\") {
		state.escaped = true;
		return true;
	}

	if (isTopLevelQuoteCharacter(character)) {
		state.quote = character;
		return true;
	}

	return false;
}

type SeparatorAdvance = number | "suffix" | "invalid" | "none";

function readTopLevelSeparatorCharacters(
	command: string,
	index: number,
	separator: "|" | "&",
): { nextCharacter: string; previousCharacter: string } | null {
	if (command[index] !== separator) {
		return null;
	}

	return {
		nextCharacter: command[index + 1] ?? "",
		previousCharacter: index > 0 ? (command[index - 1] ?? "") : "",
	};
}

function finishPipelineBeforeSuffix(
	command: string,
	index: number,
	state: PipelineParserState,
	segments: string[],
): SeparatorAdvance {
	segments.push(command.slice(state.segmentStart, index));
	state.suffix = command.slice(index);
	return "suffix";
}

function consumePipeSeparator(
	command: string,
	index: number,
	state: PipelineParserState,
	segments: string[],
	separators: string[],
): SeparatorAdvance {
	const context = readTopLevelSeparatorCharacters(command, index, "|");
	if (!context) {
		return "none";
	}
	const { nextCharacter, previousCharacter } = context;
	if (nextCharacter === "|") {
		return separators.length === 0 ? "invalid" : finishPipelineBeforeSuffix(command, index, state, segments);
	}
	if (previousCharacter === ">") {
		return "none";
	}

	const separatorLength = nextCharacter === "&" ? 2 : 1;
	segments.push(command.slice(state.segmentStart, index));
	separators.push(command.slice(index, index + separatorLength));
	state.segmentStart = index + separatorLength;
	return index + separatorLength;
}

function isRedirectAmpersand(nextCharacter: string, previousCharacter: string): boolean {
	return nextCharacter === ">" || previousCharacter === ">" || previousCharacter === "<";
}

function consumeAmpersandSeparator(
	command: string,
	index: number,
	state: PipelineParserState,
	segments: string[],
	separators: string[],
): SeparatorAdvance {
	const context = readTopLevelSeparatorCharacters(command, index, "&");
	if (!context) {
		return "none";
	}
	const { nextCharacter, previousCharacter } = context;
	if (nextCharacter === "&") {
		return separators.length === 0 ? "invalid" : finishPipelineBeforeSuffix(command, index, state, segments);
	}
	return isRedirectAmpersand(nextCharacter, previousCharacter) ? "none" : "invalid";
}

function consumeSemicolonSeparator(
	command: string,
	index: number,
	state: PipelineParserState,
	segments: string[],
	separators: string[],
): SeparatorAdvance {
	if (command[index] !== ";") {
		return "none";
	}
	return separators.length === 0 ? "invalid" : finishPipelineBeforeSuffix(command, index, state, segments);
}

function consumeTopLevelSeparator(
	command: string,
	index: number,
	state: PipelineParserState,
	segments: string[],
	separators: string[],
): SeparatorAdvance {
	for (const consume of [consumePipeSeparator, consumeAmpersandSeparator, consumeSemicolonSeparator]) {
		const advance = consume(command, index, state, segments, separators);
		if (advance !== "none") {
			return advance;
		}
	}
	return index + 1;
}

function parseSimpleTopLevelPipeline(command: string): ParsedPipeline | null {
	const segments: string[] = [];
	const separators: string[] = [];
	const state: PipelineParserState = { quote: null, escaped: false, segmentStart: 0, suffix: "" };

	for (let index = 0; index < command.length; ) {
		const character = command[index] ?? "";
		if (consumeQuotedOrEscapedCharacter(state, character)) {
			index += 1;
			continue;
		}

		const advance = consumeTopLevelSeparator(command, index, state, segments, separators);
		if (advance === "invalid") {
			return null;
		}
		if (advance === "suffix") {
			break;
		}
		if (advance === "none") {
			index += 1;
			continue;
		}
		index = advance;
	}

	if (separators.length === 0) {
		return null;
	}

	if (!state.suffix) {
		segments.push(command.slice(state.segmentStart));
	}

	return { segments, separators, suffix: state.suffix };
}

function extractProducerRewritePlan(segment: string, firstSeparator: string): ProducerRewritePlan | null {
	const trimmed = segment.trim();
	const { envPrefix, command: commandWithOptionalRedirect } = splitLeadingEnvAssignments(trimmed);
	if (!/^rtk\s+/i.test(commandWithOptionalRedirect)) {
		return null;
	}

	const stderrMergeMatch = commandWithOptionalRedirect.match(/^(.*?)(?:\s+)?2>\s*&1\s*$/u);
	if (stderrMergeMatch) {
		const command = stderrMergeMatch[1]?.trimEnd() ?? "";
		return command ? { command: `${envPrefix}${command}`.trim(), captureStderr: true } : null;
	}

	return {
		command: `${envPrefix}${commandWithOptionalRedirect}`.trim(),
		captureStderr: firstSeparator === "|&",
	};
}

function buildBufferedPipelineCommand(
	producer: ProducerRewritePlan,
	remainder: string,
): string {
	const tempFileVariable = "__pi_rtk_pipe_tmp";
	const statusVariable = "__pi_rtk_pipe_status";
	const producerRedirect = producer.captureStderr ? `> "$${tempFileVariable}" 2>&1` : `> "$${tempFileVariable}"`;
	const cleanupTrap = `rm -f "$${tempFileVariable}"`;

	return [
		"{",
		`${tempFileVariable}="$(mktemp)" || exit $?;`,
		`${statusVariable}=0;`,
		`trap '${cleanupTrap}' EXIT HUP INT TERM;`,
		`${producer.command} ${producerRedirect};`,
		`${statusVariable}=$?;`,
		`if [ $${statusVariable} -eq 0 ]; then (${remainder}) < "$${tempFileVariable}"; ${statusVariable}=$?; fi;`,
		`exit $${statusVariable};`,
		"}",
	].join(" ");
}

export function applyRewrittenCommandShellSafetyFixups(command: string, platform: string = process.platform): string {
	if (platform !== "win32") {
		return command;
	}

	const target = splitLeadingRtkDbPathExportPrelude(command);
	const parsedPipeline = parseSimpleTopLevelPipeline(target.command);
	if (!parsedPipeline) {
		return command;
	}

	const producer = extractProducerRewritePlan(parsedPipeline.segments[0] ?? "", parsedPipeline.separators[0] ?? "");
	if (!producer) {
		return command;
	}

	const remainder = parsedPipeline.segments
		.slice(1)
		.map((segment, index) => `${index === 0 ? "" : (parsedPipeline.separators[index] ?? "")}${segment}`)
		.join("")
		.trim();
	if (!remainder) {
		return command;
	}

	const suffix = parsedPipeline.suffix ? ` ${parsedPipeline.suffix.trimStart()}` : "";
	return `${target.environmentPrelude}${buildBufferedPipelineCommand(producer, remainder)}${suffix}`;
}
