import * as fs from "node:fs";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	SessionManager,
	SettingsManager,
	type ExtensionContext,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { GoalRecord } from "./goal-record.ts";

export interface GoalAuditorConfig {
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	disabled?: boolean;
}

export interface AuditorProgress {
	/** Current tool being executed by the auditor, if any */
	currentTool?: string;
	/** Arguments passed to the current tool (truncated for display) */
	currentToolArgs?: string;
	/** When the current tool started (ms since epoch) */
	currentToolStartedAt?: number;
	/** Recent text output lines from the auditor's assistant messages */
	recentOutput: string[];
	/** Phase of the audit */
	phase: "running" | "tool_executing" | "producing_report" | "done";
	/** Elapsed ms since audit started */
	elapsedMs: number;
}

export type AuditorProgressCallback = (progress: AuditorProgress) => void;

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

export function parseGoalAuditorConfig(raw: unknown): GoalAuditorConfig {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const record = raw as Record<string, unknown>;
	const config: GoalAuditorConfig = {};
	const provider = asNonEmptyString(record.provider);
	const model = asNonEmptyString(record.model);
	const thinkingLevel = asThinkingLevel(record.thinkingLevel ?? record.thinking_level);
	if (provider) config.provider = provider;
	if (model) config.model = model;
	if (thinkingLevel) config.thinkingLevel = thinkingLevel;
	if (record.disabled === true || record.disabled === "true") config.disabled = true;
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
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => [
			"You are a read-only completion auditor running in an isolated pi agent session.",
			"Inspect the repository and decide whether the claimed goal completion is genuinely satisfied.",
			"Never modify files. Never approve unless the actual user objective is complete.",
		].join("\n"),
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function resolveAuditorModel(ctx: ExtensionContext, config: GoalAuditorConfig): { model: Model<any> | undefined; error?: string } {
	if (!config.model && !config.provider) return { model: ctx.model };
	if (config.provider && config.model) {
		const model = ctx.modelRegistry.find(config.provider, config.model);
		return model ? { model } : { model: undefined, error: `Configured auditor model not found: ${config.provider}/${config.model}` };
	}
	if (config.provider) {
		const matches = ctx.modelRegistry.getAvailable().filter((model) => model.provider === config.provider);
		return matches[0] ? { model: matches[0] } : { model: undefined, error: `No available auditor model for provider: ${config.provider}` };
	}
	if (!config.model) return { model: ctx.model };
	const slash = config.model.indexOf("/");
	if (slash > 0) {
		const provider = config.model.slice(0, slash);
		const modelId = config.model.slice(slash + 1);
		const model = ctx.modelRegistry.find(provider, modelId);
		return model ? { model } : { model: undefined, error: `Configured auditor model not found: ${config.model}` };
	}
	const matches = ctx.modelRegistry.getAvailable().filter((model) => model.id === config.model || model.name === config.model);
	if (matches.length === 1) return { model: matches[0] };
	return { model: undefined, error: `Configured auditor model is ambiguous or unavailable: ${config.model}` };
}

function modelLabel(model: Model<any> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

export async function runGoalCompletionAuditor(args: {
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
}): Promise<GoalAuditorResult> {
	const config = loadGoalAuditorConfig(args.ctx.cwd);
	const resolved = resolveAuditorModel(args.ctx, config);
	const model = resolved.model;
	const thinkingLevel = config.thinkingLevel;
	const outputParts: string[] = [];
	if (resolved.error) {
		return { approved: false, disapproved: true, output: "", model: modelLabel(model), thinkingLevel, error: resolved.error };
	}
	try {
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
		const startedAt = Date.now();
		const progress: AuditorProgress = {
			recentOutput: [],
			phase: "running",
			elapsedMs: 0,
		};
		function emitProgress(): void {
			progress.elapsedMs = Date.now() - startedAt;
			args.onProgress?.({ ...progress });
		}
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				progress.currentTool = event.toolName;
				progress.currentToolArgs = typeof event.args === "object" && event.args !== null
					? JSON.stringify(event.args).slice(0, 120)
					: String(event.args ?? "").slice(0, 120);
				progress.currentToolStartedAt = Date.now();
				progress.phase = "tool_executing";
				emitProgress();
				return;
			}
			if (event.type === "tool_execution_end") {
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartedAt = undefined;
				progress.phase = "running";
				emitProgress();
				return;
			}
			if (event.type === "message_update") {
				progress.phase = "producing_report";
				const message = event.message as any;
				if (message?.role === "assistant") {
					for (const part of message.content ?? []) {
						if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
							// Keep the last 5 non-empty text lines for live display
							const lines = part.text.split("\n").filter((l: string) => l.trim());
							progress.recentOutput = [...lines.slice(-5)];
						}
					}
				}
				emitProgress();
				return;
			}
			if (event.type !== "message_end") return;
			const message = event.message as any;
			if (message.role !== "assistant") return;
			for (const part of message.content ?? []) {
				if (part.type === "text" && typeof part.text === "string") outputParts.push(part.text);
			}
			// Show the accumulated output in progress
			const fullText = outputParts.join("\n\n");
			const lines = fullText.split("\n").filter((l: string) => l.trim());
			progress.recentOutput = lines.slice(-8);
			emitProgress();
		});
		// Wire the external AbortSignal to abort the running session when fired
		// This is the mechanism that makes Esc-to-skip actually stop the auditor.
		const abortSession = () => { session.abort(); };
		args.signal?.addEventListener("abort", abortSession, { once: true });

		// Emit initial progress
		emitProgress();
		try {
			if (args.signal?.aborted) return { approved: false, disapproved: true, output: "", model: modelLabel(model), thinkingLevel, error: "Auditor aborted." };
			await session.prompt(buildGoalAuditorPrompt(args));
		} finally {
			args.signal?.removeEventListener("abort", abortSession);
			progress.phase = "done";
			emitProgress();
			unsubscribe();
		}
		// session.abort() does NOT throw — the agent loop returns normally with
		// whatever output was captured before the abort. Check the signal after
		// prompt completes and treat any abort as auditor-aborted regardless of
		// whether an exception propagated.
		if (args.signal?.aborted) {
			return {
				approved: false,
				disapproved: true,
				output: outputParts.join("\n\n").trim(),
				model: modelLabel(model),
				thinkingLevel,
				error: "Auditor aborted.",
			};
		}
		const output = outputParts.join("\n\n").trim();
		const decision = parseAuditorDecision(output);
		return { ...decision, output, model: modelLabel(model), thinkingLevel };
	} catch (error) {
		const isAborted = args.signal?.aborted || (error instanceof Error && error.name === "AbortError");
		return {
			approved: false,
			disapproved: true,
			output: outputParts.join("\n\n").trim(),
			model: modelLabel(model),
			thinkingLevel,
			error: isAborted ? "Auditor aborted." : (error instanceof Error ? error.message : String(error)),
		};
	}
}
