import { join } from "node:path";

import { splitLeadingEnvAssignments } from "./shell-env-prefix.js";

const RTK_DB_PATH_ENV_NAME = "RTK_DB_PATH";
const SINGLE_QUOTED_SHELL_VALUE_PATTERN = "'(?:'\\\\''|[^'])*'";
const SHELL_ENV_VALUE_PATTERN = `(?:"[^"]*"|${SINGLE_QUOTED_SHELL_VALUE_PATTERN}|[^\\s;]+)`;
const RTK_DB_PATH_ASSIGNMENT_PATTERN = new RegExp(
	`(?:^|\\s)RTK_DB_PATH=${SHELL_ENV_VALUE_PATTERN}(?=\\s|$)`,
);
const RTK_DB_PATH_EXPORT_PATTERN = new RegExp(`^export\\s+RTK_DB_PATH=${SHELL_ENV_VALUE_PATTERN}(?=\\s*(?:;|$))`);

function firstNonBlank(values: Array<string | undefined>): string | undefined {
	return values.find((value) => value?.trim());
}

function joinIfSet(base: string | undefined, ...paths: string[]): string | undefined {
	return base ? join(base, ...paths) : undefined;
}

function resolveNonWindowsTemporaryDirectory(): string {
	return firstNonBlank([process.env.TMPDIR, process.env.TMP]) ?? "/tmp";
}

function resolveWindowsTemporaryDirectory(): string {
	const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR;
	const candidates = [
		process.env.TEMP,
		process.env.TMP,
		joinIfSet(process.env.LOCALAPPDATA, "Temp"),
		joinIfSet(process.env.USERPROFILE, "AppData", "Local", "Temp"),
		joinIfSet(windowsRoot, "Temp"),
	];

	return firstNonBlank(candidates) ?? "C:/Windows/Temp";
}

function resolveTemporaryDirectory(): string {
	return process.platform === "win32" ? resolveWindowsTemporaryDirectory() : resolveNonWindowsTemporaryDirectory();
}

function getTemporaryRtkHistoryDbPath(): string {
	return join(resolveTemporaryDirectory(), "pi-rtk-optimizer", "history.db");
}

function quoteForShellEnv(value: string): string {
	const normalizedValue = process.platform === "win32" ? value.replace(/\\/g, "/") : value;
	return `'${normalizedValue.replace(/'/g, `'\\''`)}'`;
}

function hasLeadingRtkDbPathAssignment(command: string): boolean {
	const trimmed = command.trimStart();
	return (
		RTK_DB_PATH_ASSIGNMENT_PATTERN.test(splitLeadingEnvAssignments(trimmed).envPrefix) ||
		RTK_DB_PATH_EXPORT_PATTERN.test(trimmed)
	);
}

export function applyRtkCommandEnvironment(command: string): string {
	if (!command.trim()) {
		return command;
	}

	if (hasLeadingRtkDbPathAssignment(command)) {
		return command;
	}

	return `export ${RTK_DB_PATH_ENV_NAME}=${quoteForShellEnv(getTemporaryRtkHistoryDbPath())}; ${command}`;
}
