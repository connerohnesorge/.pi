import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type RtkExecutableResolverName = "where" | "which";

export interface RtkExecutableResolution {
	command: string;
	resolvedPath?: string;
	resolver: RtkExecutableResolverName;
	warning?: string;
}

interface ResolverCommand {
	command: RtkExecutableResolverName;
	args: string[];
}

export interface ResolveRtkExecutableOptions {
	platform?: typeof process.platform;
	timeoutMs?: number;
}

function trimResolutionDetail(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function stripWrappingQuotes(value: string): string {
	if (value.length < 2) {
		return value;
	}

	const first = value[0];
	const last = value[value.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return value.slice(1, -1);
	}

	return value;
}

function parseRtkExecutablePath(stdout: string): string | undefined {
	for (const line of stdout.split(/\r?\n/)) {
		const candidate = stripWrappingQuotes(line.trim());
		if (candidate) {
			return candidate;
		}
	}

	return undefined;
}

function getResolverCommand(platform: typeof process.platform): ResolverCommand {
	if (platform === "win32") {
		return { command: "where", args: ["rtk"] };
	}

	return { command: "which", args: ["rtk"] };
}

function fallbackResolution(resolver: RtkExecutableResolverName, warning: string): RtkExecutableResolution {
	return {
		command: "rtk",
		resolver,
		warning,
	};
}

function successfulResolution(resolver: RtkExecutableResolverName, resolvedPath: string): RtkExecutableResolution {
	return { command: resolvedPath, resolvedPath, resolver };
}

function resolutionWarning(resolver: RtkExecutableResolverName, detail: string): string {
	return `rtk executable path resolution via ${resolver} failed${detail ? `: ${detail}` : ""}`;
}

function resolutionFromExecResult(
	resolver: RtkExecutableResolverName,
	result: { code: number; stdout?: string; stderr?: string },
): RtkExecutableResolution {
	const resolvedPath = parseRtkExecutablePath(result.stdout ?? "");
	if (result.code === 0 && resolvedPath) {
		return successfulResolution(resolver, resolvedPath);
	}

	const detail = trimResolutionDetail(result.stderr || result.stdout || `exit ${result.code}`);
	return fallbackResolution(resolver, resolutionWarning(resolver, detail));
}

function resolutionFromError(resolver: RtkExecutableResolverName, error: unknown): RtkExecutableResolution {
	const message = error instanceof Error ? error.message : String(error);
	return fallbackResolution(resolver, resolutionWarning(resolver, trimResolutionDetail(message)));
}

export async function resolveRtkExecutable(
	pi: ExtensionAPI,
	options: ResolveRtkExecutableOptions = {},
): Promise<RtkExecutableResolution> {
	const resolver = getResolverCommand(options.platform ?? process.platform);

	try {
		const result = await pi.exec(resolver.command, resolver.args, { timeout: options.timeoutMs ?? 1000 });
		return resolutionFromExecResult(resolver.command, result);
	} catch (error) {
		return resolutionFromError(resolver.command, error);
	}
}
