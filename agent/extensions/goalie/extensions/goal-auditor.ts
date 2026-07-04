import * as fs from "node:fs";
import * as path from "node:path";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionContext,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { GoalRecord } from "./goal-record.ts";
import type { AuditorProgressCallback, GoalAuditorProgress } from "./goal-auditor-progress.ts";
export type { AuditorProgressCallback } from "./goal-auditor-progress.ts";

export interface GoalAuditorConfig {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	disabled?: boolean;
}

export interface GoalAuditorResult {
	approved: boolean;
	disapproved: boolean;
	output: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	error?: string;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function goalAuditorConfigPath(cwd: string): string {
	return path.join(cwd, ".pi", "goal-auditor.json");
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asThinkingLevel(value: unknown): ThinkingLevel | undefined {
	const text = asNonEmptyString(value);
	return text && THINKING_LEVELS.has(text) ? text as ThinkingLevel : undefined;
}

function asConfigRecord(raw: unknown): Record<string, unknown> | undefined {
	return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
}

function setStringConfig(config: GoalAuditorConfig, key: "provider" | "model", value: unknown): void {
	const text = asNonEmptyString(value);
	if (text) config[key] = text;
}

function setThinkingConfig(config: GoalAuditorConfig, value: unknown): void {
	const thinkingLevel = asThinkingLevel(value);
	if (thinkingLevel) config.thinkingLevel = thinkingLevel;
}

function setDisabledConfig(config: GoalAuditorConfig, value: unknown): void {
	if (value === true || value === "true") config.disabled = true;
}

export function parseGoalAuditorConfig(raw: unknown): GoalAuditorConfig {
	const record = asConfigRecord(raw);
	if (!record) return {};
	const config: GoalAuditorConfig = {};
	setStringConfig(config, "provider", record.provider);
	setStringConfig(config, "model", record.model);
	setThinkingConfig(config, record.thinkingLevel ?? record.thinking_level);
	setDisabledConfig(config, record.disabled);
	return config;
}

export function loadGoalAuditorFileConfig(cwd: string): GoalAuditorConfig {
	try {
		const configPath = goalAuditorConfigPath(cwd);
		if (fs.existsSync(configPath)) return parseGoalAuditorConfig(JSON.parse(fs.readFileSync(configPath, "utf8")));
	} catch {
		return {};
	}
	return {};
}

export function loadGoalAuditorConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): GoalAuditorConfig {
	const fileConfig = loadGoalAuditorFileConfig(cwd);
	return {
		...fileConfig,
		provider: asNonEmptyString(env.PI_GOAL_AUDITOR_PROVIDER) ?? fileConfig.provider,
		model: asNonEmptyString(env.PI_GOAL_AUDITOR_MODEL) ?? fileConfig.model,
		thinkingLevel: asThinkingLevel(env.PI_GOAL_AUDITOR_THINKING_LEVEL ?? env.PI_GOAL_AUDITOR_THINKING) ?? fileConfig.thinkingLevel,
	};
}

export function saveGoalAuditorFileConfig(cwd: string, config: GoalAuditorConfig): GoalAuditorConfig {
	const clean: GoalAuditorConfig = {};
	const provider = asNonEmptyString(config.provider);
	const model = asNonEmptyString(config.model);
	const thinkingLevel = asThinkingLevel(config.thinkingLevel);
	if (provider) clean.provider = provider;
	if (model) clean.model = model;
	if (thinkingLevel) clean.thinkingLevel = thinkingLevel;
	if (config.disabled === true) clean.disabled = true;
	const configPath = goalAuditorConfigPath(cwd);
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	const persisted: Record<string, unknown> = {};
	if (clean.provider) persisted.provider = clean.provider;
	if (clean.model) persisted.model = clean.model;
	if (clean.thinkingLevel) persisted.thinking_level = clean.thinkingLevel;
	if (clean.disabled) persisted.disabled = true;
	fs.writeFileSync(configPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
	return clean;
}

export function parseAuditorDecision(output: string): { approved: boolean; disapproved: boolean } {
	const approved = /<approved\s*\/>/.test(output);
	const disapproved = /<disapproved\s*\/>/.test(output);
	return { approved: approved && !disapproved, disapproved };
}

export function buildGoalAuditorPrompt(args: {
	goal: GoalRecord;
	completionSummary?: string | null;
	detailedSummary: string;
}): string {
	return [
		"You are the independent completion auditor for pi-goal.",
		"The executor claims the goal is complete. Your job is to decide whether the user's objective is actually satisfied.",
		"Be skeptical and semantic. Do not approve from paperwork, intent, file count, word count, build success, or a plausible summary alone.",
		"Use read/grep/find/ls/bash as needed to inspect real artifacts. Do not mutate files or run destructive commands.",
		"If the work is only an alpha scaffold, generated template, shallow draft, proxy milestone, or lacks the user-facing value requested, disapprove.",
		"If any explicit requirement is missing, weakly verified, contradicted, or not inspectable with the available evidence, disapprove.",
		"Return a concise audit report. The final line MUST be exactly one of:",
		"<approved/>",
		"<disapproved/>",
		"",
		"Goal objective:",
		"<objective>",
		args.goal.objective,
		"</objective>",
		"",
		"Executor completion claim:",
		"<completion_summary>",
		args.completionSummary?.trim() || "(none provided)",
		"</completion_summary>",
		"",
		"Current goal metadata:",
		"<goal_details>",
		args.detailedSummary,
		"</goal_details>",
		"",
		"Audit checklist:",
		"1. Extract the real success criteria from the objective, including quality/reader outcomes.",
		"2. Inspect artifacts or command output that can prove or disprove those criteria.",
		"3. Explain missing or weak evidence, especially scaffold-vs-final quality gaps.",
		"4. End with exactly <approved/> only if the objective is truly complete; otherwise end with exactly <disapproved/>.",
	].join("\n");
}

function makeAuditorResourceLoader(): ResourceLoader {
	const getAuditorExtensions = () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() });
	const getNoSkills = () => ({ skills: [], diagnostics: [] });
	const getNoPrompts = () => ({ prompts: [], diagnostics: [] });
	const getNoThemes = () => ({ themes: [], diagnostics: [] });
	const getNoAgentsFiles = () => ({ agentsFiles: [] });
	const getAuditorSystemPrompt = () => [
		"You are a read-only completion auditor running in an isolated pi agent session.",
		"Inspect the repository and decide whether the claimed goal completion is genuinely satisfied.",
		"Never modify files. Never approve unless the actual user objective is complete.",
	].join("\n");
	const getNoAppendSystemPrompt = () => [];
	const noopExtendResources = () => {};
	const noopReload = async () => {};
	return {
		getExtensions: getAuditorExtensions,
		getSkills: getNoSkills,
		getPrompts: getNoPrompts,
		getThemes: getNoThemes,
		getAgentsFiles: getNoAgentsFiles,
		getSystemPrompt: getAuditorSystemPrompt,
		getAppendSystemPrompt: getNoAppendSystemPrompt,
		extendResources: noopExtendResources,
		reload: noopReload,
	};
}

type ResolvedAuditorModel = { model: Model<any> | undefined; error?: string };

function foundModel(model: Model<any> | undefined, error: string): ResolvedAuditorModel {
	return model ? { model } : { model: undefined, error };
}

function resolveProviderModel(ctx: ExtensionContext, provider: string, modelId?: string): ResolvedAuditorModel {
	if (modelId) return foundModel(ctx.modelRegistry.find(provider, modelId), `Configured auditor model not found: ${provider}/${modelId}`);
	return foundModel(
		ctx.modelRegistry.getAvailable().find((model) => model.provider === provider),
		`No available auditor model for provider: ${provider}`,
	);
}

function resolveNamedModel(ctx: ExtensionContext, modelName: string): ResolvedAuditorModel {
	const slash = modelName.indexOf("/");
	if (slash > 0) return resolveProviderModel(ctx, modelName.slice(0, slash), modelName.slice(slash + 1));
	const matches = ctx.modelRegistry.getAvailable().filter((model) => model.id === modelName || model.name === modelName);
	return matches.length === 1
		? { model: matches[0] }
		: { model: undefined, error: `Configured auditor model is ambiguous or unavailable: ${modelName}` };
}

function resolveAuditorModel(ctx: ExtensionContext, config: GoalAuditorConfig): ResolvedAuditorModel {
	if (config.provider) return resolveProviderModel(ctx, config.provider, config.model);
	return config.model ? resolveNamedModel(ctx, config.model) : { model: ctx.model };
}

function modelLabel(model: Model<any> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

type AuditorSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

type RunGoalCompletionAuditorArgs = {
	ctx: ExtensionContext;
	goal: GoalRecord;
	completionSummary?: string | null;
	detailedSummary: string;
	signal?: AbortSignal;
	onProgress?: AuditorProgressCallback;
	/**
	 * Optional factory for creating the auditor agent session.
	 * Exposed for testing so a mock/controllable session can be injected.
	 * Defaults to the real createAgentSession from @earendil-works/pi-coding-agent.
	 */
	createSession?: typeof createAgentSession;
};

type AuditorRunState = {
	outputParts: string[];
	progress: GoalAuditorProgress;
	startedAt: number;
	onProgress?: AuditorProgressCallback;
};

function disapprovedResult(args: {
	outputParts?: string[];
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	error?: string;
}): GoalAuditorResult {
	return {
		approved: false,
		disapproved: true,
		output: args.outputParts?.join("\n\n").trim() ?? "",
		model: modelLabel(args.model),
		thinkingLevel: args.thinkingLevel,
		error: args.error,
	};
}

function emitAuditorProgress(state: AuditorRunState): void {
	state.progress.elapsedMs = Date.now() - state.startedAt;
	state.onProgress?.({ ...state.progress });
}

function assistantText(message: any): string[] {
	if (message?.role !== "assistant") return [];
	return (message.content ?? [])
		.filter((part: any) => part.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text);
}

function updateRecentOutput(state: AuditorRunState, text: string, lineCount: number): void {
	state.progress.recentOutput = text.split("\n").filter((line) => line.trim()).slice(-lineCount);
}

function handleAuditorToolEvent(event: any, state: AuditorRunState): boolean {
	if (event.type === "tool_execution_start") {
		state.progress.currentTool = event.toolName;
		state.progress.currentToolArgs = typeof event.args === "object" && event.args !== null
			? JSON.stringify(event.args).slice(0, 120)
			: String(event.args ?? "").slice(0, 120);
		state.progress.currentToolStartedAt = Date.now();
		state.progress.phase = "tool_executing";
		emitAuditorProgress(state);
		return true;
	}
	if (event.type !== "tool_execution_end") return false;
	state.progress.currentTool = undefined;
	state.progress.currentToolArgs = undefined;
	state.progress.currentToolStartedAt = undefined;
	state.progress.phase = "running";
	emitAuditorProgress(state);
	return true;
}

function handleAuditorEvent(event: any, state: AuditorRunState): void {
	if (handleAuditorToolEvent(event, state)) return;
	if (event.type === "message_update") {
		state.progress.phase = "producing_report";
		for (const text of assistantText(event.message)) updateRecentOutput(state, text, 5);
		emitAuditorProgress(state);
		return;
	}
	if (event.type !== "message_end") return;
	state.outputParts.push(...assistantText(event.message));
	updateRecentOutput(state, state.outputParts.join("\n\n"), 8);
	emitAuditorProgress(state);
}

async function createAuditorSession(args: RunGoalCompletionAuditorArgs, model: Model<any> | undefined, thinkingLevel: ThinkingLevel | undefined): Promise<AuditorSession> {
	const createSession = args.createSession ?? createAgentSession;
	const { session } = await createSession({
		cwd: args.ctx.cwd,
		model,
		thinkingLevel,
		modelRegistry: args.ctx.modelRegistry,
		resourceLoader: makeAuditorResourceLoader(),
		sessionManager: SessionManager.inMemory(args.ctx.cwd),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
		tools: ["read", "grep", "find", "ls", "bash"],
	});
	return session;
}

async function runAuditorPrompt(args: RunGoalCompletionAuditorArgs, session: AuditorSession, state: AuditorRunState): Promise<void> {
	const unsubscribe = session.subscribe((event) => handleAuditorEvent(event, state));
	const abortSession = () => { session.abort(); };
	args.signal?.addEventListener("abort", abortSession, { once: true });
	emitAuditorProgress(state);
	try {
		if (args.signal?.aborted) return;
		await session.prompt(buildGoalAuditorPrompt(args));
	} finally {
		args.signal?.removeEventListener("abort", abortSession);
		state.progress.phase = "done";
		emitAuditorProgress(state);
		unsubscribe();
	}
}

function auditorError(args: RunGoalCompletionAuditorArgs, error: unknown): string {
	return args.signal?.aborted || (error instanceof Error && error.name === "AbortError")
		? "Auditor aborted."
		: (error instanceof Error ? error.message : String(error));
}

async function runResolvedAuditor(
	args: RunGoalCompletionAuditorArgs,
	model: Model<any> | undefined,
	thinkingLevel: ThinkingLevel | undefined,
): Promise<GoalAuditorResult> {
	const outputParts: string[] = [];
	try {
		const session = await createAuditorSession(args, model, thinkingLevel);
		await runAuditorPrompt(args, session, {
			outputParts,
			progress: { recentOutput: [], phase: "running", elapsedMs: 0 },
			startedAt: Date.now(),
			onProgress: args.onProgress,
		});
		if (args.signal?.aborted) return disapprovedResult({ outputParts, model, thinkingLevel, error: "Auditor aborted." });
		const output = outputParts.join("\n\n").trim();
		return { ...parseAuditorDecision(output), output, model: modelLabel(model), thinkingLevel };
	} catch (error) {
		return disapprovedResult({ outputParts, model, thinkingLevel, error: auditorError(args, error) });
	}
}

export async function runGoalCompletionAuditor(args: RunGoalCompletionAuditorArgs): Promise<GoalAuditorResult> {
	const config = loadGoalAuditorConfig(args.ctx.cwd);
	const resolved = resolveAuditorModel(args.ctx, config);
	return resolved.error
		? disapprovedResult({ model: resolved.model, thinkingLevel: config.thinkingLevel, error: resolved.error })
		: runResolvedAuditor(args, resolved.model, config.thinkingLevel);
}
