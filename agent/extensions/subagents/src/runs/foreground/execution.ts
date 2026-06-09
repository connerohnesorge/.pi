/**
 * Core execution logic for running subagents
 */

import { existsSync } from "node:fs";
import type { AgentConfig } from "../../agents/agents.ts";
import {
	ensureArtifactsDir,
	getArtifactPaths,
	writeArtifact,
	writeMetadata,
} from "../../shared/artifacts.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	type ControlEvent,
	type ModelAttempt,
	type RunSyncOptions,
	type SingleResult,
	type Usage,
	DEFAULT_MAX_OUTPUT,
	INTERCOM_DETACH_REQUEST_EVENT,
	INTERCOM_DETACH_RESPONSE_EVENT,
	truncateOutput,
} from "../../shared/types.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	claimControlNotification,
	deriveActivityState,
	shouldNotifyControlEvent,
} from "../shared/subagent-control.ts";
import {
	getFinalOutput,
	findLatestSessionFile,
	detectSubagentError,
	extractToolArgsPreview,
	extractTextFromContent,
} from "../../shared/utils.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { evaluateCompletionMutationGuard } from "../shared/completion-guard.ts";
import { accumulateAssistantUsage, driveChildProcess, type ChildEvent } from "../shared/child-driver.ts";
import { createJsonlWriter } from "../../shared/jsonl-writer.ts";
import { applyThinkingSuffix, buildPiArgs, cleanupTempDir } from "../shared/pi-args.ts";
import { captureSingleOutputSnapshot, formatSavedOutputReference, resolveSingleOutput, validateFileOnlyOutputMode, type SingleOutputSnapshot } from "../shared/single-output.ts";
import {
	buildModelCandidates,
	formatModelAttemptNote,
	isRetryableModelFailure,
} from "../shared/model-fallback.ts";
import {
	createMutatingFailureState,
	didMutatingToolFail,
	isMutatingTool,
	nextLongRunningTrigger,
	recordMutatingFailure,
	resetMutatingFailureState,
	resolveCurrentPath,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "../shared/long-running-guard.ts";

const artifactOutputByResult = new WeakMap<SingleResult, string>();

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function sumUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

function appendRecentOutput(progress: AgentProgress, lines: string[]): void {
	if (lines.length === 0) return;
	progress.recentOutput.push(...lines.filter((line) => line.trim()));
	if (progress.recentOutput.length > 50) {
		progress.recentOutput.splice(0, progress.recentOutput.length - 50);
	}
}

function snapshotProgress(progress: AgentProgress): AgentProgress {
	return {
		...progress,
		skills: progress.skills ? [...progress.skills] : undefined,
		recentTools: progress.recentTools.map((tool) => ({ ...tool })),
		recentOutput: [...progress.recentOutput],
	};
}

function snapshotResult(result: SingleResult, progress: AgentProgress): SingleResult {
	return {
		...result,
		messages: result.outputMode === "file-only" && result.savedOutputPath ? undefined : result.messages ? [...result.messages] : undefined,
		usage: { ...result.usage },
		skills: result.skills ? [...result.skills] : undefined,
		attemptedModels: result.attemptedModels ? [...result.attemptedModels] : undefined,
		modelAttempts: result.modelAttempts
			? result.modelAttempts.map((attempt) => ({
				...attempt,
				usage: attempt.usage ? { ...attempt.usage } : undefined,
			}))
			: undefined,
		controlEvents: result.controlEvents ? result.controlEvents.map((event) => ({ ...event })) : undefined,
		progress,
		progressSummary: result.progressSummary ? { ...result.progressSummary } : undefined,
		artifactPaths: result.artifactPaths ? { ...result.artifactPaths } : undefined,
		truncation: result.truncation ? { ...result.truncation } : undefined,
		outputReference: result.outputReference ? { ...result.outputReference } : undefined,
	};
}

async function runSingleAttempt(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	model: string | undefined,
	options: RunSyncOptions,
	shared: {
		sessionEnabled: boolean;
		systemPrompt: string;
		resolvedSkillNames?: string[];
		skillsWarning?: string;
		jsonlPath?: string;
		artifactPaths?: ArtifactPaths;
		attemptNotes: string[];
		outputSnapshot?: SingleOutputSnapshot;
	},
): Promise<SingleResult> {
	const modelArg = applyThinkingSuffix(model, agent.thinking);
	const { args, env: sharedEnv, tempDir } = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task,
		sessionEnabled: shared.sessionEnabled,
		sessionDir: options.sessionDir,
		sessionFile: options.sessionFile,
		model,
		thinking: agent.thinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		tools: agent.tools,
		extensions: agent.extensions,
		systemPrompt: shared.systemPrompt,
		mcpDirectTools: agent.mcpDirectTools,
		cwd: options.cwd ?? runtimeCwd,
		promptFileStem: agent.name,
		intercomSessionName: options.intercomSessionName,
		orchestratorIntercomTarget: options.orchestratorIntercomTarget,
		runId: options.runId,
		childAgentName: agent.name,
		childIndex: options.index ?? 0,
		parentEventSink: options.nestedRoute?.eventSink,
		parentControlInbox: options.nestedRoute?.controlInbox,
		parentRootRunId: options.nestedRoute?.rootRunId,
		parentCapabilityToken: options.nestedRoute?.capabilityToken,
	});

	const result: SingleResult = {
		agent: agent.name,
		task,
		exitCode: 0,
		messages: [],
		usage: emptyUsage(),
		model: modelArg,
		artifactPaths: shared.artifactPaths,
		skills: shared.resolvedSkillNames,
		skillsWarning: shared.skillsWarning,
	};
	const startTime = Date.now();
	const controlConfig = options.controlConfig ?? DEFAULT_CONTROL_CONFIG;
	let interruptedByControl = false;
	const allControlEvents: ControlEvent[] = [];
	let pendingControlEvents: ControlEvent[] = [];
	const emittedControlEventKeys = new Set<string>();
	const emitControlEvent = (event: ControlEvent) => {
		if (!shouldNotifyControlEvent(controlConfig, event)) return;
		if (!claimControlNotification(controlConfig, event, emittedControlEventKeys)) return;
		allControlEvents.push(event);
		pendingControlEvents.push(event);
		options.onControlEvent?.(event);
	};

	const progress: AgentProgress = {
		index: options.index ?? 0,
		agent: agent.name,
		status: "running",
		task,
		skills: shared.resolvedSkillNames,
		recentTools: [],
		recentOutput: [...shared.attemptNotes],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		lastActivityAt: startTime,
	};
	result.progress = progress;
	let observedMutationAttempt = false;

	// Foreground projection state. The shared driver owns spawn/parse/usage/drain/kill;
	// this projection mirrors the parsed event stream into in-process progress and emits
	// live `onUpdate` snapshots, and layers on the foreground-only lifecycle
	// (intercom-detach, jsonl artifact, temp cleanup, AbortSignal kill).
	let jsonlWriter: { writeLine(line: string): void; close(): Promise<void> } = {
		writeLine() {},
		async close() {},
	};
	let processClosed = false;
	let detached = false;
	let intercomStarted = false;
	let removeAbortListener: (() => void) | undefined;
	let removeInterruptListener: (() => void) | undefined;
	let activityTimer: NodeJS.Timeout | undefined;
	let driverInterrupt: (() => void) | undefined;
	let driverDetach: (() => void) | undefined;
	const killController = new AbortController();

	const detachForIntercom = () => {
		if (detached || processClosed) return;
		detached = true;
		processClosed = true;
		result.detached = true;
		result.detachedReason = "intercom coordination";
		progress.status = "detached";
		progress.durationMs = Date.now() - startTime;
		result.progressSummary = {
			toolCount: progress.toolCount,
			tokens: progress.tokens,
			durationMs: progress.durationMs,
		};
		// Resolve the driver early without killing the child (it keeps running,
		// handed off to intercom coordination).
		driverDetach?.();
	};

	const unsubscribeIntercomDetach = options.intercomEvents?.on?.(INTERCOM_DETACH_REQUEST_EVENT, (payload) => {
		if (!options.allowIntercomDetach || detached || processClosed || !intercomStarted) return;
		if (!payload || typeof payload !== "object") return;
		const requestId = (payload as { requestId?: unknown }).requestId;
		if (typeof requestId !== "string" || requestId.length === 0) return;
		options.intercomEvents?.emit(INTERCOM_DETACH_RESPONSE_EVENT, { requestId, accepted: true });
		detachForIntercom();
	});

	const drainPendingControlEvents = (): ControlEvent[] | undefined => {
		if (pendingControlEvents.length === 0) return undefined;
		const events = pendingControlEvents;
		pendingControlEvents = [];
		return events;
	};

	let activeLongRunningNotified = false;
	let pendingToolResult: { tool: string; path?: string; mutates: boolean; startedAt?: number } | undefined;
	const mutatingFailures = createMutatingFailureState();
	const mutatingFailureWindowMs = 5 * 60_000;
	const currentToolDurationMs = (now: number) => progress.currentToolStartedAt ? Math.max(0, now - progress.currentToolStartedAt) : undefined;
	const emitNeedsAttention = (now: number, input: { message?: string; reason?: ControlEvent["reason"]; recentFailureSummary?: string; currentTool?: string; currentPath?: string; currentToolDurationMs?: number } = {}): boolean => {
		if (!controlConfig.enabled) return false;
		const previous = progress.activityState;
		progress.activityState = "needs_attention";
		const event = buildControlEvent({
			type: "needs_attention",
			from: previous,
			to: "needs_attention",
			runId: options.runId,
			agent: agent.name,
			index: options.index,
			ts: now,
			lastActivityAt: progress.lastActivityAt,
			message: input.message,
			reason: input.reason ?? "idle",
			turns: result.usage.turns,
			tokens: progress.tokens,
			toolCount: progress.toolCount,
			currentTool: input.currentTool ?? progress.currentTool,
			currentToolDurationMs: input.currentToolDurationMs ?? currentToolDurationMs(now),
			currentPath: input.currentPath ?? progress.currentPath,
			recentFailureSummary: input.recentFailureSummary,
		});
		emitControlEvent(event);
		return previous !== "needs_attention";
	};
	const emitActiveLongRunning = (now: number, reason: ControlEvent["reason"]): boolean => {
		if (!controlConfig.enabled || activeLongRunningNotified || progress.activityState === "needs_attention") return false;
		activeLongRunningNotified = true;
		const previous = progress.activityState;
		progress.activityState = "active_long_running";
		emitControlEvent(buildControlEvent({
			type: "active_long_running",
			from: previous,
			to: "active_long_running",
			runId: options.runId,
			agent: agent.name,
			index: options.index,
			ts: now,
			message: `${agent.name} is still active but long-running`,
			reason,
			turns: result.usage.turns,
			tokens: progress.tokens,
			toolCount: progress.toolCount,
			currentTool: progress.currentTool,
			currentToolDurationMs: currentToolDurationMs(now),
			currentPath: progress.currentPath,
			elapsedMs: now - startTime,
		}));
		return true;
	};
	const updateActivityState = (now: number): boolean => {
		if (!controlConfig.enabled) return false;
		const idleState = deriveActivityState({
			config: controlConfig,
			startedAt: startTime,
			lastActivityAt: progress.lastActivityAt,
			now,
		});
		if (idleState === "needs_attention") {
			return progress.activityState === "needs_attention" ? false : emitNeedsAttention(now);
		}
		const activeReason = nextLongRunningTrigger(controlConfig, {
			startedAt: startTime,
			now,
			turns: result.usage.turns,
			tokens: progress.tokens,
		});
		return activeReason ? emitActiveLongRunning(now, activeReason) : false;
	};


	const emitUpdateSnapshot = (text: string) => {
		if (!options.onUpdate || processClosed) return;
		const progressSnapshot = snapshotProgress(progress);
		const resultSnapshot = snapshotResult(result, progressSnapshot);
		const controlEvents = drainPendingControlEvents();
		options.onUpdate({
			content: [{ type: "text", text }],
			details: {
				mode: "single",
				results: [resultSnapshot],
				progress: [progressSnapshot],
				controlEvents,
			},
		});
	};

	const fireUpdate = () => {
		if (!options.onUpdate || processClosed) return;
		progress.durationMs = Date.now() - startTime;
		emitUpdateSnapshot(getFinalOutput(result.messages) || "(running...)");
	};

	const handleEvent = (evt: ChildEvent) => {
		const now = Date.now();
		progress.durationMs = now - startTime;
		progress.lastActivityAt = now;
		updateActivityState(now);

		if (evt.type === "tool_execution_start") {
			const toolArgs = evt.args && typeof evt.args === "object" && !Array.isArray(evt.args)
				? evt.args as Record<string, unknown>
				: {};
			if (options.allowIntercomDetach && (evt.toolName === "intercom" || evt.toolName === "contact_supervisor")) {
				intercomStarted = true;
			}
			progress.toolCount++;
			progress.currentTool = evt.toolName;
			progress.currentToolArgs = extractToolArgsPreview(toolArgs);
			progress.currentToolStartedAt = now;
			progress.currentPath = resolveCurrentPath(evt.toolName, toolArgs);
			const mutates = isMutatingTool(evt.toolName, toolArgs);
			observedMutationAttempt = observedMutationAttempt || mutates;
			pendingToolResult = { tool: evt.toolName ?? "tool", path: progress.currentPath, mutates, startedAt: now };
			fireUpdate();
		}

		if (evt.type === "tool_execution_end") {
			if (progress.currentTool) {
				progress.recentTools.push({
					tool: progress.currentTool,
					args: progress.currentToolArgs || "",
					endMs: now,
				});
			}
			progress.currentTool = undefined;
			progress.currentToolArgs = undefined;
			progress.currentToolStartedAt = undefined;
			progress.currentPath = undefined;
			fireUpdate();
		}

		if (evt.type === "message_end" && evt.message) {
			result.messages.push(evt.message);
			if (evt.message.role === "assistant") {
				result.usage.turns++;
				progress.turnCount = result.usage.turns;
				accumulateAssistantUsage(result.usage, evt.message.usage);
				progress.tokens = result.usage.input + result.usage.output;
				if (!result.model && evt.message.model) result.model = evt.message.model;
				const assistantText = extractTextFromContent(evt.message.content);
				appendRecentOutput(progress, assistantText.split("\n").slice(-10));
			}
			updateActivityState(now);
			fireUpdate();
		}

		if (evt.type === "tool_result_end" && evt.message) {
			result.messages.push(evt.message);
			const resultText = extractTextFromContent(evt.message.content);
			appendRecentOutput(progress, resultText.split("\n").slice(-10));
			const toolSnapshot = pendingToolResult;
			pendingToolResult = undefined;
			if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
				recordMutatingFailure(mutatingFailures, {
					tool: toolSnapshot.tool,
					path: toolSnapshot.path,
					error: resultText.split("\n").find((line) => line.trim())?.trim().slice(0, 180) ?? "mutating tool failed",
					ts: now,
				}, mutatingFailureWindowMs);
				if (shouldEscalateMutatingFailures(mutatingFailures, controlConfig.failedToolAttemptsBeforeAttention)) {
					emitNeedsAttention(now, {
						message: `${agent.name} needs attention after repeated mutating tool failures`,
						reason: "tool_failures",
						currentTool: toolSnapshot.tool,
						currentPath: toolSnapshot.path,
						currentToolDurationMs: toolSnapshot.startedAt ? Math.max(0, now - toolSnapshot.startedAt) : undefined,
						recentFailureSummary: summarizeRecentMutatingFailures(mutatingFailures),
					});
				}
			} else if (toolSnapshot?.mutates) {
				resetMutatingFailureState(mutatingFailures);
			}
			fireUpdate();
		}
	};

	if (controlConfig.enabled) {
		activityTimer = setInterval(() => {
			if (processClosed || detached) return;
			const now = Date.now();
			if (updateActivityState(now)) {
				progress.durationMs = now - startTime;
				fireUpdate();
			}
		}, 1000);
		activityTimer.unref?.();
	}

	// Kick off the driver. `registerInterrupt`/`registerDetach` are invoked
	// synchronously during setup, so `driverInterrupt`/`driverDetach` are populated
	// before the promise settles and before the signal listeners below can fire.
	const driverPromise = driveChildProcess({
		args,
		cwd: options.cwd ?? runtimeCwd,
		env: sharedEnv,
		maxSubagentDepth: options.maxSubagentDepth,
		signal: killController.signal,
		onStdout: (source) => {
			jsonlWriter = createJsonlWriter(shared.jsonlPath, source);
		},
		onStdoutLine: (line) => {
			jsonlWriter.writeLine(line);
		},
		onEvent: handleEvent,
		registerInterrupt: (interrupt) => {
			driverInterrupt = interrupt;
		},
		registerDetach: (detach) => {
			driverDetach = detach;
		},
	});

	if (options.signal) {
		const onAbort = () => {
			if (processClosed || detached) return;
			// While intercom is active, an abort detaches (hands the child to intercom)
			// instead of killing; otherwise escalate the driver's kill.
			if (options.allowIntercomDetach && intercomStarted && !detached) {
				detachForIntercom();
				return;
			}
			killController.abort();
		};
		if (options.signal.aborted) onAbort();
		else {
			const abortSignal = options.signal;
			abortSignal.addEventListener("abort", onAbort, { once: true });
			removeAbortListener = () => abortSignal.removeEventListener("abort", onAbort);
		}
	}

	if (options.interruptSignal) {
		const interrupt = () => {
			if (processClosed || detached) return;
			interruptedByControl = true;
			progress.status = "running";
			progress.durationMs = Date.now() - startTime;
			result.interrupted = true;
			result.finalOutput = "Interrupted. Waiting for explicit next action.";
			progress.activityState = undefined;
			fireUpdate();
			driverInterrupt?.();
		};
		if (options.interruptSignal.aborted) interrupt();
		else {
			const interruptSignal = options.interruptSignal;
			interruptSignal.addEventListener("abort", interrupt, { once: true });
			removeInterruptListener = () => interruptSignal.removeEventListener("abort", interrupt);
		}
	}

	const driverResult = await driverPromise;

	if (activityTimer) {
		clearInterval(activityTimer);
		activityTimer = undefined;
	}
	unsubscribeIntercomDetach?.();
	removeAbortListener?.();
	removeInterruptListener?.();
	void jsonlWriter.close().catch(() => {
		// JSONL artifact flush is best effort.
	});
	cleanupTempDir(tempDir);
	processClosed = true;

	// `result.messages`/`result.usage`/`result.model`/`observedMutationAttempt` are
	// maintained live by the projection (`handleEvent`) for snapshots; the driver
	// supplies the normalized exit code and termination signals.
	result.exitCode = driverResult.exitCode ?? 0;

	if (interruptedByControl) {
		result.exitCode = 0;
		result.interrupted = true;
		result.error = undefined;
		result.finalOutput = result.finalOutput || "Interrupted. Waiting for explicit next action.";
		result.controlEvents = allControlEvents.length ? allControlEvents : undefined;
		progress.activityState = undefined;
		progress.durationMs = Date.now() - startTime;
		result.progressSummary = {
			toolCount: progress.toolCount,
			tokens: progress.tokens,
			durationMs: progress.durationMs,
		};
		return result;
	}
	if (result.detached) {
		result.exitCode = 0;
		result.finalOutput = "Detached for intercom coordination.";
		return result;
	}

	// Normal path: derive the error from the driver's signals, layering the
	// foreground-only stderr fallback (background does not do this).
	if (!result.error && driverResult.error) result.error = driverResult.error;
	const forcedDrainAfterFinalSuccess = driverResult.forcedTermination && driverResult.cleanTerminalStop && !result.error;
	if (driverResult.exitCode !== 0 && driverResult.stderr.trim() && !result.error && !forcedDrainAfterFinalSuccess) {
		result.error = driverResult.stderr.trim();
	}

	if (result.error && result.exitCode === 0) {
		result.exitCode = 1;
	}
	if (result.exitCode === 0 && !result.error) {
		const errInfo = detectSubagentError(result.messages);
		if (errInfo.hasError) {
			result.exitCode = errInfo.exitCode ?? 1;
			result.error = errInfo.details
				? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
				: `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`;
		}
	}

	progress.status = result.exitCode === 0 ? "completed" : "failed";
	progress.durationMs = Date.now() - startTime;
	if (result.error) {
		progress.error = result.error;
		if (progress.currentTool) {
			progress.failedTool = progress.currentTool;
		}
	}

	result.progressSummary = {
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
	};

	let fullOutput = getFinalOutput(result.messages);
	const completionGuard = result.exitCode === 0 && !result.error && agent.completionGuard !== false
		? evaluateCompletionMutationGuard({
			agent: agent.name,
			task,
			messages: result.messages,
			tools: agent.tools,
			mcpDirectTools: agent.mcpDirectTools,
		})
		: undefined;
	if (completionGuard?.triggered && !observedMutationAttempt) {
		result.exitCode = 1;
		result.error = "Subagent completed without making edits for an implementation task.\nIt appears to have returned planning or scratchpad output instead of applying changes.";
		progress.status = "failed";
		progress.error = result.error;
		emitControlEvent(buildControlEvent({
			from: progress.activityState,
			to: "needs_attention",
			runId: options.runId ?? agent.name,
			agent: agent.name,
			index: options.index,
			ts: Date.now(),
			message: `${agent.name} completed without making edits for an implementation task`,
			reason: "completion_guard",
		}));
	}
	if (options.outputPath && result.exitCode === 0) {
		const resolvedOutput = resolveSingleOutput(options.outputPath, fullOutput, shared.outputSnapshot);
		fullOutput = resolvedOutput.fullOutput;
		result.savedOutputPath = resolvedOutput.savedPath;
		result.outputSaveError = resolvedOutput.saveError;
		if (resolvedOutput.savedPath) {
			result.outputReference = formatSavedOutputReference(resolvedOutput.savedPath, fullOutput);
		}
	}
	artifactOutputByResult.set(result, fullOutput);
	result.outputMode = options.outputMode ?? "inline";
	result.finalOutput = options.outputMode === "file-only" && result.savedOutputPath && result.outputReference
		? result.outputReference.message
		: fullOutput;
	result.controlEvents = allControlEvents.length ? allControlEvents : undefined;
	if (options.onUpdate) {
		const finalText = result.finalOutput || result.error || "(no output)";
		const progressSnapshot = snapshotProgress(progress);
		const resultSnapshot = snapshotResult(result, progressSnapshot);
		options.onUpdate({
			content: [{ type: "text", text: finalText }],
			details: {
				mode: "single",
				results: [resultSnapshot],
				progress: [progressSnapshot],
				controlEvents: allControlEvents.length ? allControlEvents : undefined,
			},
		});
	}
	return result;
}

/**
 * Run a subagent synchronously (blocking until complete)
 */
export async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: `Unknown agent: ${agentName}`,
		};
	}
	const outputModeValidationError = validateFileOnlyOutputMode(options.outputMode, options.outputPath, `Single run (${agentName})`);
	if (outputModeValidationError) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			outputMode: options.outputMode,
			error: outputModeValidationError,
		};
	}

	const shareEnabled = options.share === true;
	const sessionEnabled = Boolean(options.sessionFile || options.sessionDir) || shareEnabled;
	const skillNames = options.skills ?? agent.skills ?? [];
	const skillCwd = options.cwd ?? runtimeCwd;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, skillCwd, runtimeCwd);
	if (skillNames.some((skill) => skill.trim() === "pi-subagents") && missingSkills.includes("pi-subagents")) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: "Skills not found: pi-subagents",
		};
	}
	let systemPrompt = agent.systemPrompt?.trim() || "";
	if (resolvedSkills.length > 0) {
		const skillInjection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${skillInjection}` : skillInjection;
	}

	const candidates = buildModelCandidates(
		options.modelOverride ?? agent.model,
		agent.fallbackModels,
		options.availableModels,
		options.preferredModelProvider,
	);
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [];
	const aggregateUsage = emptyUsage();
	const attemptNotes: string[] = [];
	let totalToolCount = 0;
	let totalDurationMs = 0;

	let artifactPathsResult: ArtifactPaths | undefined;
	let jsonlPath: string | undefined;
	if (options.artifactsDir && options.artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(options.artifactsDir, options.runId, agentName, options.index);
		ensureArtifactsDir(options.artifactsDir);
		if (options.artifactConfig?.includeInput !== false) {
			writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${task}`);
		}
		if (options.artifactConfig?.includeJsonl !== false) {
			jsonlPath = artifactPathsResult.jsonlPath;
		}
	}

	let lastResult: SingleResult | undefined;
	const modelsToTry = candidates.length > 0 ? candidates : [undefined];
	for (let i = 0; i < modelsToTry.length; i++) {
		const candidate = modelsToTry[i];
		if (candidate) attemptedModels.push(candidate);
		const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);
		const result = await runSingleAttempt(runtimeCwd, agent, task, candidate, options, {
			sessionEnabled,
			systemPrompt,
			resolvedSkillNames: resolvedSkills.length > 0 ? resolvedSkills.map((skill) => skill.name) : undefined,
			skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
			jsonlPath,
			artifactPaths: artifactPathsResult,
			attemptNotes,
			outputSnapshot,
		});
		lastResult = result;
		sumUsage(aggregateUsage, result.usage);
		totalToolCount += result.progressSummary?.toolCount ?? 0;
		totalDurationMs += result.progressSummary?.durationMs ?? 0;
		const attemptSucceeded = result.exitCode === 0 && !result.error;
		const attempt: ModelAttempt = {
			model: candidate ?? result.model ?? agent.model ?? "default",
			success: attemptSucceeded,
			exitCode: result.exitCode,
			error: result.error,
			usage: { ...result.usage },
		};
		modelAttempts.push(attempt);
		if (attemptSucceeded) {
			break;
		}
		if (!isRetryableModelFailure(result.error) || i === modelsToTry.length - 1) {
			break;
		}
		attemptNotes.push(formatModelAttemptNote(attempt, modelsToTry[i + 1]));
	}

	const result = lastResult ?? {
		agent: agentName,
		task,
		exitCode: 1,
		messages: [],
		usage: emptyUsage(),
		error: "Subagent did not produce a result.",
	} satisfies SingleResult;

	result.usage = aggregateUsage;
	result.attemptedModels = attemptedModels.length > 0 ? attemptedModels : undefined;
	result.modelAttempts = modelAttempts.length > 0 ? modelAttempts : undefined;
	result.progressSummary = {
		toolCount: totalToolCount,
		tokens: aggregateUsage.input + aggregateUsage.output,
		durationMs: totalDurationMs,
	};
	if (attemptNotes.length > 0 && result.progress) {
		result.progress.recentOutput = [...attemptNotes, ...result.progress.recentOutput];
		if (result.progress.recentOutput.length > 50) {
			result.progress.recentOutput.splice(50);
		}
	}

	if (artifactPathsResult && options.artifactConfig?.enabled !== false) {
		result.artifactPaths = artifactPathsResult;
		if (options.artifactConfig?.includeOutput !== false) {
			writeArtifact(artifactPathsResult.outputPath, artifactOutputByResult.get(result) ?? result.finalOutput ?? "");
		}
		if (options.artifactConfig?.includeMetadata !== false) {
			writeMetadata(artifactPathsResult.metadataPath, {
				runId: options.runId,
				agent: agentName,
				task,
				exitCode: result.exitCode,
				usage: result.usage,
				model: result.model,
				attemptedModels: result.attemptedModels,
				modelAttempts: result.modelAttempts,
				durationMs: result.progressSummary?.durationMs,
				toolCount: result.progressSummary?.toolCount,
				error: result.error,
				skills: result.skills,
				skillsWarning: result.skillsWarning,
				timestamp: Date.now(),
			});
		}

		if (options.maxOutput) {
			const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
			const truncationResult = truncateOutput(result.finalOutput ?? "", config, artifactPathsResult.outputPath);
			if (truncationResult.truncated) result.truncation = truncationResult;
		}
	} else if (options.maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
		const truncationResult = truncateOutput(result.finalOutput ?? "", config);
		if (truncationResult.truncated) result.truncation = truncationResult;
	}

	if (options.sessionFile && (existsSync(options.sessionFile) || result.messages?.length)) {
		result.sessionFile = options.sessionFile;
	} else if (shareEnabled && options.sessionDir) {
		const sessionFile = findLatestSessionFile(options.sessionDir);
		if (sessionFile) result.sessionFile = sessionFile;
	}

	return result;
}
