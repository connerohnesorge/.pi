import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveRtkExecutable, type RtkExecutableResolution } from "./rtk-executable-resolver.js";

export interface RtkRewriteProviderResult {
	changed: boolean;
	originalCommand: string;
	rewrittenCommand: string;
	exitCode: number;
	error?: string;
	executableResolution?: RtkExecutableResolution;
}

export interface RtkRewriteProviderOptions {
	timeoutMs?: number;
	resolverTimeoutMs?: number;
	platform?: typeof process.platform;
	executableResolution?: RtkExecutableResolution;
}

function isAlreadyRtk(command: string): boolean {
	const trimmed = command.trimStart();
	return trimmed === "rtk" || trimmed.startsWith("rtk ");
}

function normalizeOptions(optionsOrTimeout: number | RtkRewriteProviderOptions): RtkRewriteProviderOptions {
	if (typeof optionsOrTimeout === "number") {
		return { timeoutMs: optionsOrTimeout };
	}
	return optionsOrTimeout;
}

function unchangedResult(
	command: string,
	exitCode: number,
	extra: Partial<RtkRewriteProviderResult> = {},
): RtkRewriteProviderResult {
	return { changed: false, originalCommand: command, rewrittenCommand: command, exitCode, ...extra };
}

async function resolveRewriteExecutable(
	pi: ExtensionAPI,
	options: RtkRewriteProviderOptions,
): Promise<RtkExecutableResolution> {
	return (
		options.executableResolution ??
		(await resolveRtkExecutable(pi, {
			platform: options.platform,
			timeoutMs: options.resolverTimeoutMs,
		}))
	);
}

function resultFromRtkExit(
	command: string,
	code: number,
	stdout: string | undefined,
	stderr: string | undefined,
	executableResolution: RtkExecutableResolution,
): RtkRewriteProviderResult {
	if (code === 1) {
		return unchangedResult(command, 1, { executableResolution });
	}
	if (code === 2) {
		return unchangedResult(command, 2, { error: stderr?.trim() || "rtk denied rewrite", executableResolution });
	}
	if (code !== 0 && code !== 3) {
		return unchangedResult(command, code, { error: `unexpected exit code ${code}`, executableResolution });
	}

	const rewritten = stdout?.trim();
	if (!rewritten) {
		return unchangedResult(command, code, { error: "rtk returned empty output", executableResolution });
	}
	if (rewritten === command) {
		return unchangedResult(command, code, { executableResolution });
	}
	return { changed: true, originalCommand: command, rewrittenCommand: rewritten, exitCode: code, executableResolution };
}

export async function resolveRtkRewrite(
	pi: ExtensionAPI,
	command: string,
	optionsOrTimeout: number | RtkRewriteProviderOptions = {},
): Promise<RtkRewriteProviderResult> {
	const options = normalizeOptions(optionsOrTimeout);
	if (!command?.trim() || isAlreadyRtk(command)) {
		return unchangedResult(command, 1);
	}

	try {
		const executableResolution = await resolveRewriteExecutable(pi, options);
		const result = await pi.exec(executableResolution.command, ["rewrite", command], { timeout: options.timeoutMs ?? 3000 });
		return resultFromRtkExit(command, result.code, result.stdout, result.stderr, executableResolution);
	} catch (error) {
		return unchangedResult(command, -1, { error: error instanceof Error ? error.message : String(error) });
	}
}
