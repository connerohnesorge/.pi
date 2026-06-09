/**
 * Shared child-process driver for subagent execution.
 *
 * Owns the duplicated core that both the foreground (synchronous) and background
 * (detached) execution paths used to re-implement independently: spawning the
 * child `pi` process, line-buffering and JSON-parsing stdout, accumulating
 * messages and usage, the terminal-stop drain handshake (grace -> SIGTERM ->
 * SIGKILL), signal escalation, and exit-code derivation.
 *
 * Presentation stays in the callers. The driver emits each parsed event through
 * `onEvent` and returns a normalized `ChildDriverResult`; each caller projects
 * that stream independently (foreground: in-process progress + live snapshots;
 * background: file-backed status + JSONL sideband).
 */

import { spawn } from "node:child_process";
import type { Message } from "@earendil-works/pi-ai";
import { getSubagentDepthEnv, type Usage } from "../../shared/types.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import { getPiSpawnCommand } from "./pi-spawn.ts";
import { extractTextFromContent, getFinalOutput } from "../../shared/utils.ts";
import { isMutatingTool } from "./long-running-guard.ts";

/** Usage block as emitted by the child, accepting both token-field spellings. */
export interface ChildUsage {
	input?: number;
	inputTokens?: number;
	output?: number;
	outputTokens?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export type ChildMessage = Message & {
	model?: string;
	errorMessage?: string;
	usage?: ChildUsage;
};

export interface ChildEvent {
	type?: string;
	message?: ChildMessage;
	toolName?: string;
	args?: Record<string, unknown>;
}

/** Normalized terminal result, the superset both projections map from. */
export interface ChildDriverResult {
	exitCode: number | null;
	messages: Message[];
	usage: Usage;
	model?: string;
	error?: string;
	stderr: string;
	finalOutput: string;
	/** Raw (non-JSON) stdout lines, in order — used by the background fallback. */
	rawStdout: string[];
	interrupted: boolean;
	detached: boolean;
	observedMutationAttempt: boolean;
	/** A termination signal (SIGTERM/SIGKILL) was actually delivered during the drain. */
	forcedTermination: boolean;
	/** A clean terminal assistant stop (no errorMessage) was observed. */
	cleanTerminalStop: boolean;
}

/** Narrow flow-control handle over the child's stdout for projection-side backpressure. */
export interface StdoutBackpressureSource {
	pause(): void;
	resume(): void;
}

export interface DriveChildProcessSpec {
	args: string[];
	cwd: string;
	env?: Record<string, string | undefined>;
	piPackageRoot?: string;
	piArgv1?: string;
	maxSubagentDepth?: number;
	/** Parsed JSON events, in order — accumulation happens before each call. */
	onEvent?: (event: ChildEvent) => void;
	/** Non-JSON stdout lines, in order. */
	onRawStdoutLine?: (line: string) => void;
	/** Every raw stdout line (JSON or not), in order, before parsing. */
	onStdoutLine?: (line: string) => void;
	/** Raw stderr chunks, as received. */
	onStderrText?: (text: string) => void;
	/**
	 * Receives a narrow pause/resume handle for the child's stdout once spawned,
	 * letting a projection apply backpressure (e.g. a file artifact writer) without
	 * the driver leaking the raw stream or owning the artifact.
	 */
	onStdout?: (source: StdoutBackpressureSource) => void;
	/** Abort -> SIGTERM, then SIGKILL after the hard-kill window if still alive. */
	signal?: AbortSignal;
	/** Receives an interrupt trigger (SIGINT -> SIGTERM, marks interrupted). */
	registerInterrupt?: (interrupt: (() => void) | undefined) => void;
	/** Receives a detach trigger (resolve early without killing, marks detached). */
	registerDetach?: (detach: (() => void) | undefined) => void;
}

const FINAL_STOP_GRACE_MS = 1000;
const HARD_KILL_MS = 3000;

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

/**
 * Accumulate one assistant message's usage into a running total, accepting the
 * superset of token-field spellings (`input`/`inputTokens`, `output`/`outputTokens`).
 * This is the single home for assistant usage accounting shared by the driver and
 * the foreground projection (ADR-0002), so both execution paths report identical totals.
 */
export function accumulateAssistantUsage(usage: Usage, eventUsage: ChildUsage | undefined): void {
	if (!eventUsage) return;
	usage.input += eventUsage.input ?? eventUsage.inputTokens ?? 0;
	usage.output += eventUsage.output ?? eventUsage.outputTokens ?? 0;
	usage.cacheRead += eventUsage.cacheRead ?? 0;
	usage.cacheWrite += eventUsage.cacheWrite ?? 0;
	usage.cost += eventUsage.cost?.total ?? 0;
}

export function driveChildProcess(spec: DriveChildProcessSpec): Promise<ChildDriverResult> {
	return new Promise((resolve) => {
		const spawnEnv = { ...process.env, ...(spec.env ?? {}), ...getSubagentDepthEnv(spec.maxSubagentDepth) };
		const spawnSpec = getPiSpawnCommand(spec.args, {
			...(spec.piPackageRoot ? { piPackageRoot: spec.piPackageRoot } : {}),
			...(spec.piArgv1 ? { argv1: spec.piArgv1 } : {}),
		});
		const child = spawn(spawnSpec.command, spawnSpec.args, {
			cwd: spec.cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: spawnEnv,
			windowsHide: true,
		});

		spec.onStdout?.({
			pause: () => child.stdout?.pause(),
			resume: () => child.stdout?.resume(),
		});

		let stdoutBuf = "";
		let stderr = "";
		const messages: Message[] = [];
		const usage = emptyUsage();
		let model: string | undefined;
		let error: string | undefined;
		let assistantError: string | undefined;
		let interrupted = false;
		let detached = false;
		let observedMutationAttempt = false;
		const rawStdout: string[] = [];

		let childExited = false;
		let forcedTerminationSignal = false;
		let cleanTerminalAssistantStopReceived = false;
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let finalHardKillTimer: NodeJS.Timeout | undefined;
		let settled = false;
		let removeAbortListener: (() => void) | undefined;

		const clearStdioGuard = attachPostExitStdioGuard(child, { idleMs: 2000, hardMs: 8000 });

		const clearDrainTimers = () => {
			if (finalDrainTimer) {
				clearTimeout(finalDrainTimer);
				finalDrainTimer = undefined;
			}
			if (finalHardKillTimer) {
				clearTimeout(finalHardKillTimer);
				finalHardKillTimer = undefined;
			}
		};

		const startFinalDrain = (): void => {
			if (childExited || finalDrainTimer || settled || detached) return;
			finalDrainTimer = setTimeout(() => {
				if (settled || detached) return;
				const termSent = trySignalChild(child, "SIGTERM");
				if (!termSent) return;
				forcedTerminationSignal = true;
				if (!cleanTerminalAssistantStopReceived && !error && !assistantError) {
					error = `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its final message. Forcing termination.`;
				}
				finalHardKillTimer = setTimeout(() => {
					if (settled || detached) return;
					forcedTerminationSignal = trySignalChild(child, "SIGKILL") || forcedTerminationSignal;
				}, HARD_KILL_MS);
				finalHardKillTimer.unref?.();
			}, FINAL_STOP_GRACE_MS);
			finalDrainTimer.unref?.();
		};

		const processStdoutLine = (line: string) => {
			if (!line.trim()) return;
			spec.onStdoutLine?.(line);
			let event: ChildEvent;
			try {
				event = JSON.parse(line) as ChildEvent;
			} catch {
				rawStdout.push(line);
				spec.onRawStdoutLine?.(line);
				return;
			}

			spec.onEvent?.(event);

			if (event.type === "tool_execution_start" && event.toolName) {
				observedMutationAttempt = observedMutationAttempt || isMutatingTool(event.toolName, event.args);
				return;
			}

			if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
				messages.push(event.message);
				if (event.type !== "message_end" || event.message.role !== "assistant") return;
				if (event.message.model) model = event.message.model;
				if (event.message.errorMessage) assistantError = event.message.errorMessage;
				usage.turns++;
				accumulateAssistantUsage(usage, event.message.usage);
				const stopReason = (event.message as { stopReason?: string }).stopReason;
				const hasToolCall = Array.isArray(event.message.content)
					&& event.message.content.some((part) => (part as { type?: string }).type === "toolCall");
				if (stopReason === "stop" && !hasToolCall) {
					if (!event.message.errorMessage && extractTextFromContent(event.message.content).trim()) assistantError = undefined;
					cleanTerminalAssistantStopReceived ||= !event.message.errorMessage;
					startFinalDrain();
				}
			}
		};

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBuf += chunk.toString();
			const lines = stdoutBuf.split("\n");
			stdoutBuf = lines.pop() || "";
			for (const line of lines) processStdoutLine(line);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stderr += text;
			spec.onStderrText?.(text);
		});

		const cleanup = () => {
			clearDrainTimers();
			clearStdioGuard();
			removeAbortListener?.();
			spec.registerInterrupt?.(undefined);
			spec.registerDetach?.(undefined);
		};

		const settleResult = (rawCode: number | null, signal: NodeJS.Signals | null): ChildDriverResult => {
			const finalError = error ?? assistantError;
			const forcedDrainAfterFinalSuccess = forcedTerminationSignal && cleanTerminalAssistantStopReceived && !finalError;
			const resolvedError = interrupted || forcedDrainAfterFinalSuccess ? undefined : finalError;
			const exitCode = detached
				? null
				: interrupted || forcedDrainAfterFinalSuccess
					? 0
					: forcedTerminationSignal || signal
						? (rawCode ?? 1)
						: (rawCode ?? 0);
			const finalOutput = getFinalOutput(messages) || rawStdout.join("\n").trim();
			return {
				exitCode,
				messages,
				usage,
				model,
				error: resolvedError,
				stderr,
				finalOutput,
				rawStdout,
				interrupted,
				detached,
				observedMutationAttempt,
				forcedTermination: forcedTerminationSignal,
				cleanTerminalStop: cleanTerminalAssistantStopReceived,
			};
		};

		spec.registerInterrupt?.(() => {
			if (settled) return;
			interrupted = true;
			if (!error) error = "Interrupted. Waiting for explicit next action.";
			trySignalChild(child, "SIGINT");
			setTimeout(() => {
				if (!settled) trySignalChild(child, "SIGTERM");
			}, 1000).unref?.();
		});

		// Detach: resolve the driver early without killing the child (it keeps
		// running, e.g. handed off to intercom coordination). The caller's
		// projection owns the meaning of detachment; the driver only stops driving.
		spec.registerDetach?.(() => {
			if (settled) return;
			settled = true;
			detached = true;
			cleanup();
			resolve(settleResult(null, null));
		});

		if (spec.signal) {
			const kill = () => {
				if (settled || detached) return;
				trySignalChild(child, "SIGTERM");
				setTimeout(() => {
					if (!settled && !child.killed) trySignalChild(child, "SIGKILL");
				}, HARD_KILL_MS).unref?.();
			};
			if (spec.signal.aborted) kill();
			else {
				const signal = spec.signal;
				signal.addEventListener("abort", kill, { once: true });
				removeAbortListener = () => signal.removeEventListener("abort", kill);
			}
		}

		child.on("exit", () => {
			childExited = true;
			clearDrainTimers();
		});

		child.on("close", (exitCode, signal) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (stdoutBuf.trim()) processStdoutLine(stdoutBuf);
			resolve(settleResult(exitCode, signal));
		});

		child.on("error", (spawnError) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (!error && !assistantError) {
				error = spawnError instanceof Error ? spawnError.message : String(spawnError);
			}
			// Spawn-error path mirrors both callers: report the spawn error (or an
			// earlier error/assistantError) as-is. Interrupt-clearing is left to the
			// caller's post-loop, matching the original foreground/background handlers.
			const finalError = error ?? assistantError;
			const finalOutput = getFinalOutput(messages) || rawStdout.join("\n").trim();
			resolve({
				exitCode: 1,
				messages,
				usage,
				model,
				error: finalError,
				stderr,
				finalOutput,
				rawStdout,
				interrupted,
				detached,
				observedMutationAttempt,
				forcedTermination: forcedTerminationSignal,
				cleanTerminalStop: cleanTerminalAssistantStopReceived,
			});
		});
	});
}
