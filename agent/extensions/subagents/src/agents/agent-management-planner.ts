import * as path from "node:path";
import {
	type AgentConfig,
	type AgentScope,
	type AgentSource,
	type ChainConfig,
	type ChainStepConfig,
	buildRuntimeName,
	defaultInheritProjectContext,
	defaultInheritSkills,
	defaultSystemPromptMode,
	frontmatterNameForConfig,
	parsePackageName,
} from "./agents.ts";
import { splitToolList } from "./agent-fields.ts";

export type ManagementAction = "list" | "get" | "create" | "update" | "delete";
export type ManagementScope = "user" | "project";

export interface ManagementParams {
	action?: string;
	agent?: string;
	chainName?: string;
	agentScope?: string;
	config?: unknown;
}

export interface ManagementCatalog {
	builtin: AgentConfig[];
	user: AgentConfig[];
	project: AgentConfig[];
	chains: ChainConfig[];
}

export interface WarningContext {
	models: Array<{ provider: string; id: string }>;
	skills: Array<{ name: string }>;
}

export type TargetPlan<T extends { source: AgentSource; filePath: string }> =
	| { ok: true; target: T }
	| { ok: false; error: string };

export type DeletePlan =
	| { ok: true; kind: "agent"; target: AgentConfig; lines: string[]; warnings: string[] }
	| { ok: true; kind: "chain"; target: ChainConfig; lines: string[]; warnings: string[] }
	| { ok: false; error: string };

export function parseCsv(value: string): string[] {
	return [...new Set(value.split(",").map((v) => v.trim()).filter(Boolean))];
}

export function configObject(config: unknown): { value?: Record<string, unknown>; error?: string } {
	let val = config;
	if (typeof val === "string") {
		try {
			val = JSON.parse(val);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { error: `config must be valid JSON: ${message}` };
		}
	}
	if (!val || typeof val !== "object" || Array.isArray(val)) return {};
	return { value: val as Record<string, unknown> };
}

export function hasKey(obj: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(obj, key);
}

export function asDisambiguationScope(scope: unknown): ManagementScope | undefined {
	if (scope === "user" || scope === "project") return scope;
	return undefined;
}

export function normalizeListScope(scope: unknown): AgentScope | undefined {
	if (scope === undefined) return "both";
	if (scope === "user" || scope === "project" || scope === "both") return scope;
	return undefined;
}

export function sanitizeName(name: string): string {
	return name.toLowerCase().trim().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

export function parsePackageConfig(value: unknown): { packageName?: string; error?: string } {
	return parsePackageName(value, "config.package");
}

export function resolveUpdatedIdentity(
	target: AgentConfig | ChainConfig,
	cfg: Record<string, unknown>,
): { newLocalName: string; newPackageName?: string; error?: string } {
	if (hasKey(cfg, "name") && (typeof cfg.name !== "string" || !cfg.name.trim())) {
		return { newLocalName: "", error: "config.name must be a non-empty string when provided." };
	}
	if (hasKey(cfg, "description") && (typeof cfg.description !== "string" || !cfg.description.trim())) {
		return { newLocalName: "", error: "config.description must be a non-empty string when provided." };
	}
	let newLocalName = target.localName ?? frontmatterNameForConfig(target);
	if (hasKey(cfg, "name")) {
		newLocalName = sanitizeName(cfg.name as string);
		if (!newLocalName) return { newLocalName, error: "config.name is invalid after sanitization." };
	}
	let newPackageName = target.packageName;
	if (hasKey(cfg, "package")) {
		const parsedPackage = parsePackageConfig(cfg.package);
		if (parsedPackage.error) return { newLocalName, error: parsedPackage.error };
		newPackageName = parsedPackage.packageName;
	}
	return { newLocalName, newPackageName };
}

export function allAgents(d: Pick<ManagementCatalog, "builtin" | "user" | "project">): AgentConfig[] {
	return [...d.builtin, ...d.user, ...d.project];
}

export function availableNames(catalog: ManagementCatalog, kind: "agent" | "chain"): string[] {
	const items = kind === "agent" ? allAgents(catalog) : catalog.chains;
	return [...new Set(items.map((x) => x.name))].sort((a, b) => a.localeCompare(b));
}

export function findAgentsInCatalog(name: string, catalog: ManagementCatalog, scope: AgentScope = "both"): AgentConfig[] {
	const raw = name.trim();
	const sanitized = sanitizeName(raw);
	return allAgents(catalog)
		.filter((a) => (scope === "both" || a.source === scope) && (a.name === raw || a.name === sanitized))
		.sort((a, b) => a.source.localeCompare(b.source));
}

export function findChainsInCatalog(name: string, catalog: ManagementCatalog, scope: AgentScope = "both"): ChainConfig[] {
	const raw = name.trim();
	const sanitized = sanitizeName(raw);
	return catalog.chains
		.filter((c) => (scope === "both" || c.source === scope) && (c.name === raw || c.name === sanitized))
		.sort((a, b) => a.source.localeCompare(b.source));
}

export function nameExistsInCatalog(catalog: ManagementCatalog, scope: ManagementScope, name: string, excludePath?: string): boolean {
	for (const a of scope === "user" ? catalog.user : catalog.project) {
		if (a.name === name && a.filePath !== excludePath) return true;
	}
	for (const c of catalog.chains) {
		if (c.source === scope && c.name === name && c.filePath !== excludePath) return true;
	}
	return false;
}

export function unknownChainAgents(catalog: ManagementCatalog, steps: ChainStepConfig[]): string[] {
	const known = new Set(allAgents(catalog).map((a) => a.name));
	return [...new Set(steps.map((s) => s.agent).filter((a) => !known.has(a)))].sort((a, b) => a.localeCompare(b));
}

export function chainStepWarnings(ctx: WarningContext, steps: ChainStepConfig[]): string[] {
	const warnings: string[] = [];
	const available = new Set(ctx.skills.map((s) => s.name));
	for (let i = 0; i < steps.length; i++) {
		const s = steps[i]!;
		if (s.model) {
			const found = ctx.models.some((m) => `${m.provider}/${m.id}` === s.model || m.id === s.model);
			if (!found) warnings.push(`Warning: step ${i + 1} (${s.agent}): model '${s.model}' is not in the current model registry.`);
		}
		if (Array.isArray(s.skills) && s.skills.length > 0) {
			const missing = s.skills.filter((sk) => !available.has(sk));
			if (missing.length) warnings.push(`Warning: step ${i + 1} (${s.agent}): skills not found: ${missing.join(", ")}.`);
		}
	}
	return warnings;
}

export function modelWarning(ctx: WarningContext, model: string | undefined): string | undefined {
	if (!model) return undefined;
	const found = ctx.models.some((m) => `${m.provider}/${m.id}` === model || m.id === model);
	return found ? undefined : `Warning: model '${model}' is not in the current model registry.`;
}

export function fallbackModelsWarning(ctx: WarningContext, fallbackModels: string[] | undefined): string | undefined {
	if (!fallbackModels || fallbackModels.length === 0) return undefined;
	const available = new Set(ctx.models.flatMap((m) => [`${m.provider}/${m.id}`, m.id]));
	const missing = fallbackModels.filter((model) => !available.has(model));
	return missing.length ? `Warning: fallback models not in the current model registry: ${missing.join(", ")}.` : undefined;
}

export function skillsWarning(ctx: WarningContext, skills: string[] | undefined): string | undefined {
	if (!skills || skills.length === 0) return undefined;
	const available = new Set(ctx.skills.map((s) => s.name));
	const missing = skills.filter((s) => !available.has(s));
	return missing.length ? `Warning: skills not found: ${missing.join(", ")}.` : undefined;
}

export function parseStepList(raw: unknown): { steps?: ChainStepConfig[]; error?: string } {
	if (!Array.isArray(raw)) return { error: "config.steps must be an array." };
	if (raw.length === 0) return { error: "config.steps must include at least one step." };
	const steps: ChainStepConfig[] = [];
	for (let i = 0; i < raw.length; i++) {
		const item = raw[i];
		if (!item || typeof item !== "object" || Array.isArray(item)) return { error: `config.steps[${i}] must be an object.` };
		const s = item as Record<string, unknown>;
		if (typeof s.agent !== "string" || !s.agent.trim()) return { error: `config.steps[${i}].agent must be a non-empty string.` };
		const step: ChainStepConfig = { agent: s.agent.trim(), task: typeof s.task === "string" ? s.task : "" };
		if (hasKey(s, "output")) {
			if (s.output === false) step.output = false;
			else if (typeof s.output === "string") step.output = s.output;
			else return { error: `config.steps[${i}].output must be a string or false.` };
		}
		if (hasKey(s, "outputMode")) {
			if (s.outputMode === "inline" || s.outputMode === "file-only") step.outputMode = s.outputMode;
			else return { error: `config.steps[${i}].outputMode must be 'inline' or 'file-only'.` };
		}
		if (hasKey(s, "reads")) {
			if (s.reads === false) step.reads = false;
			else if (Array.isArray(s.reads)) step.reads = s.reads.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
			else return { error: `config.steps[${i}].reads must be an array or false.` };
		}
		if (hasKey(s, "model")) {
			if (typeof s.model === "string") step.model = s.model;
			else return { error: `config.steps[${i}].model must be a string.` };
		}
		if (hasKey(s, "skills")) {
			if (s.skills === false) step.skills = false;
			else if (Array.isArray(s.skills)) step.skills = s.skills.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean);
			else return { error: `config.steps[${i}].skills must be an array or false.` };
		}
		if (hasKey(s, "progress")) {
			if (typeof s.progress === "boolean") step.progress = s.progress;
			else return { error: `config.steps[${i}].progress must be a boolean.` };
		}
		steps.push(step);
	}
	return { steps };
}

export function applyAgentConfig(target: AgentConfig, cfg: Record<string, unknown>): string | undefined {
	if (hasKey(cfg, "systemPrompt")) {
		if (cfg.systemPrompt === false || cfg.systemPrompt === "") target.systemPrompt = "";
		else if (typeof cfg.systemPrompt === "string") target.systemPrompt = cfg.systemPrompt;
		else return "config.systemPrompt must be a string or false when provided.";
	}
	if (hasKey(cfg, "model")) {
		if (cfg.model === false || cfg.model === "") target.model = undefined;
		else if (typeof cfg.model === "string") target.model = cfg.model.trim() || undefined;
		else return "config.model must be a string or false when provided.";
	}
	if (hasKey(cfg, "fallbackModels")) {
		if (cfg.fallbackModels === false || cfg.fallbackModels === "") target.fallbackModels = undefined;
		else if (typeof cfg.fallbackModels === "string") {
			const models = parseCsv(cfg.fallbackModels);
			target.fallbackModels = models.length ? models : undefined;
		} else if (Array.isArray(cfg.fallbackModels)) {
			const models = cfg.fallbackModels
				.filter((value): value is string => typeof value === "string")
				.map((value) => value.trim())
				.filter(Boolean);
			target.fallbackModels = models.length ? [...new Set(models)] : undefined;
		} else return "config.fallbackModels must be a comma-separated string, string array, or false when provided.";
	}
	if (hasKey(cfg, "tools")) {
		if (cfg.tools === false || cfg.tools === "") { target.tools = undefined; target.mcpDirectTools = undefined; }
		else if (typeof cfg.tools === "string") { const parsed = splitToolList(parseCsv(cfg.tools)); target.tools = parsed.tools; target.mcpDirectTools = parsed.mcpDirectTools; }
		else return "config.tools must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "skills")) {
		if (cfg.skills === false || cfg.skills === "") target.skills = undefined;
		else if (typeof cfg.skills === "string") { const skills = parseCsv(cfg.skills); target.skills = skills.length ? skills : undefined; }
		else return "config.skills must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "extensions")) {
		if (cfg.extensions === false) target.extensions = undefined;
		else if (cfg.extensions === "") target.extensions = [];
		else if (typeof cfg.extensions === "string") target.extensions = parseCsv(cfg.extensions);
		else return "config.extensions must be a comma-separated string, empty string, or false when provided.";
	}
	if (hasKey(cfg, "thinking")) {
		if (cfg.thinking === false || cfg.thinking === "") target.thinking = undefined;
		else if (typeof cfg.thinking === "string") target.thinking = cfg.thinking.trim() || undefined;
		else return "config.thinking must be a string or false when provided.";
	}
	if (hasKey(cfg, "systemPromptMode")) {
		if (cfg.systemPromptMode === "append" || cfg.systemPromptMode === "replace") target.systemPromptMode = cfg.systemPromptMode;
		else return "config.systemPromptMode must be 'append' or 'replace' when provided.";
	}
	if (hasKey(cfg, "inheritProjectContext")) {
		if (typeof cfg.inheritProjectContext !== "boolean") return "config.inheritProjectContext must be a boolean when provided.";
		target.inheritProjectContext = cfg.inheritProjectContext;
	}
	if (hasKey(cfg, "inheritSkills")) {
		if (typeof cfg.inheritSkills !== "boolean") return "config.inheritSkills must be a boolean when provided.";
		target.inheritSkills = cfg.inheritSkills;
	}
	if (hasKey(cfg, "defaultContext")) {
		if (cfg.defaultContext === false || cfg.defaultContext === "") target.defaultContext = undefined;
		else if (cfg.defaultContext === "fresh" || cfg.defaultContext === "fork") target.defaultContext = cfg.defaultContext;
		else return "config.defaultContext must be 'fresh', 'fork', or false when provided.";
	}
	if (hasKey(cfg, "output")) {
		if (cfg.output === false || cfg.output === "") target.output = undefined;
		else if (typeof cfg.output === "string") target.output = cfg.output;
		else return "config.output must be a string or false when provided.";
	}
	if (hasKey(cfg, "reads")) {
		if (cfg.reads === false || cfg.reads === "") target.defaultReads = undefined;
		else if (typeof cfg.reads === "string") {
			const reads = parseCsv(cfg.reads);
			target.defaultReads = reads.length ? reads : undefined;
		} else return "config.reads must be a comma-separated string or false when provided.";
	}
	if (hasKey(cfg, "progress")) {
		if (typeof cfg.progress !== "boolean") return "config.progress must be a boolean when provided.";
		target.defaultProgress = cfg.progress;
	}
	if (hasKey(cfg, "maxSubagentDepth")) {
		if (cfg.maxSubagentDepth === false || cfg.maxSubagentDepth === "") target.maxSubagentDepth = undefined;
		else if (typeof cfg.maxSubagentDepth === "number" && Number.isInteger(cfg.maxSubagentDepth) && cfg.maxSubagentDepth >= 0) {
			target.maxSubagentDepth = cfg.maxSubagentDepth;
		} else return "config.maxSubagentDepth must be an integer >= 0 or false when provided.";
	}
	if (hasKey(cfg, "completionGuard")) {
		if (typeof cfg.completionGuard !== "boolean") return "config.completionGuard must be a boolean when provided.";
		target.completionGuard = cfg.completionGuard;
	}
	return undefined;
}

export function resolveTargetPlan<T extends { source: AgentSource; filePath: string }>(
	kind: "agent" | "chain",
	name: string,
	matches: T[],
	catalog: ManagementCatalog,
	scopeHint?: string,
): TargetPlan<T> {
	const mutable = matches.filter((m) => m.source !== "builtin");
	if (mutable.length === 0) {
		if (matches.length > 0) {
			return { ok: false, error: `${kind === "agent" ? "Agent" : "Chain"} '${name}' is builtin and cannot be modified. Create a same-named ${kind} in user or project scope to override it.` };
		}
		return { ok: false, error: `${kind === "agent" ? "Agent" : "Chain"} '${name}' not found. Available: ${availableNames(catalog, kind).join(", ") || "none"}.` };
	}
	if (mutable.length === 1) return { ok: true, target: mutable[0]! };
	const scope = asDisambiguationScope(scopeHint);
	if (!scope) {
		const paths = mutable.map((m) => `${m.source}: ${m.filePath}`).join("\n");
		return { ok: false, error: `${kind === "agent" ? "Agent" : "Chain"} '${name}' exists in both scopes. Specify agentScope: 'user' or 'project'.\n${paths}` };
	}
	const scoped = mutable.filter((m) => m.source === scope);
	if (scoped.length === 0) return { ok: false, error: `${kind === "agent" ? "Agent" : "Chain"} '${name}' not found in scope '${scope}'.` };
	if (scoped.length > 1) return { ok: false, error: `Multiple ${kind}s named '${name}' found in scope '${scope}': ${scoped.map((m) => m.filePath).join(", ")}` };
	return { ok: true, target: scoped[0]! };
}

export function planDelete(params: ManagementParams, catalog: ManagementCatalog): DeletePlan {
	if (!params.agent && !params.chainName) return { ok: false, error: "Specify 'agent' or 'chainName' for delete." };
	if (params.agent && params.chainName) return { ok: false, error: "Specify either 'agent' or 'chainName', not both." };
	const scopeHint = asDisambiguationScope(params.agentScope);
	if (params.agent) {
		const targetPlan = resolveTargetPlan("agent", params.agent, findAgentsInCatalog(params.agent, catalog, scopeHint ?? "both"), catalog, params.agentScope);
		if (!targetPlan.ok) return targetPlan;
		const target = targetPlan.target;
		const refs = catalog.chains.filter((c) => c.steps.some((s) => s.agent === target.name)).map((c) => `${c.name} (${c.source})`);
		const warnings = refs.length ? [`Warning: chains reference deleted agent '${target.name}': ${refs.join(", ")}.`] : [];
		return { ok: true, kind: "agent", target, warnings, lines: [`Deleted agent '${target.name}' at ${target.filePath}.`, ...warnings] };
	}
	const targetPlan = resolveTargetPlan("chain", params.chainName!, findChainsInCatalog(params.chainName!, catalog, scopeHint ?? "both"), catalog, params.agentScope);
	if (!targetPlan.ok) return targetPlan;
	return { ok: true, kind: "chain", target: targetPlan.target, warnings: [], lines: [`Deleted chain '${targetPlan.target.name}' at ${targetPlan.target.filePath}.`] };
}

export function buildCreateRuntimeIdentity(cfg: Record<string, unknown>):
	| { ok: true; name: string; packageName?: string; runtimeName: string; scope: ManagementScope; isChain: boolean; description: string }
	| { ok: false; error: string } {
	if (typeof cfg.name !== "string" || !cfg.name.trim()) return { ok: false, error: "config.name is required and must be a non-empty string." };
	if (typeof cfg.description !== "string" || !cfg.description.trim()) return { ok: false, error: "config.description is required and must be a non-empty string." };
	const description = cfg.description.trim();
	const name = sanitizeName(cfg.name);
	if (!name) return { ok: false, error: "config.name is invalid after sanitization. Use letters, numbers, spaces, or hyphens." };
	const parsedPackage = parsePackageConfig(cfg.package);
	if (parsedPackage.error) return { ok: false, error: parsedPackage.error };
	const runtimeName = buildRuntimeName(name, parsedPackage.packageName);
	const scopeRaw = cfg.scope ?? "user";
	if (scopeRaw !== "user" && scopeRaw !== "project") return { ok: false, error: "config.scope must be 'user' or 'project'." };
	return { ok: true, name, packageName: parsedPackage.packageName, runtimeName, scope: scopeRaw, isChain: hasKey(cfg, "steps"), description };
}

export interface ManagementDirectories {
	cwd: string;
	userAgentDir: string;
	projectAgentDir: string;
	userChainDir: string;
	projectChainDir: string;
}

export interface ManagementPlanFacts {
	catalog: ManagementCatalog;
	directories: ManagementDirectories;
	warnings: WarningContext | (() => WarningContext);
	pathExists(filePath: string): boolean;
}

function warningFacts(facts: ManagementPlanFacts): WarningContext {
	return typeof facts.warnings === "function" ? facts.warnings() : facts.warnings;
}

export type ManagementFileOperation =
	| { type: "write-agent"; targetDir: string; filePath: string; agent: AgentConfig }
	| { type: "write-chain"; targetDir: string; filePath: string; chain: ChainConfig }
	| { type: "rename"; kind: "agent" | "chain"; from: string; to: string }
	| { type: "delete"; kind: "agent" | "chain"; filePath: string };

export type ManagementPlan =
	| { ok: false; error: string }
	| { ok: true; action: "list"; agents: AgentConfig[]; chains: ChainConfig[] }
	| { ok: true; action: "get"; items: Array<{ kind: "agent"; agent: AgentConfig } | { kind: "chain"; chain: ChainConfig } | { kind: "message"; text: string }>; anyFound: boolean }
	| { ok: true; action: "create"; entity: "agent"; operation: Extract<ManagementFileOperation, { type: "write-agent" }>; warnings: string[] }
	| { ok: true; action: "create"; entity: "chain"; operation: Extract<ManagementFileOperation, { type: "write-chain" }>; warnings: string[] }
	| { ok: true; action: "update"; entity: "agent"; oldName: string; updated: AgentConfig; operations: ManagementFileOperation[]; warnings: string[] }
	| { ok: true; action: "update"; entity: "chain"; oldName: string; updated: ChainConfig; operations: ManagementFileOperation[]; warnings: string[] }
	| { ok: true; action: "delete"; entity: "agent"; target: AgentConfig; operations: ManagementFileOperation[]; warnings: string[] }
	| { ok: true; action: "delete"; entity: "chain"; target: ChainConfig; operations: ManagementFileOperation[]; warnings: string[] };

function scopedList(catalog: ManagementCatalog, scope: AgentScope): { agents: AgentConfig[]; chains: ChainConfig[] } {
	const scopedAgents = allAgents(catalog)
		.filter((a) => scope === "both" || a.source === "builtin" || a.source === scope)
		.sort((a, b) => a.name.localeCompare(b.name));
	const agents = scopedAgents.filter((a) => !a.disabled);
	const chains = catalog.chains
		.filter((c) => scope === "both" || c.source === scope)
		.sort((a, b) => a.name.localeCompare(b.name));
	return { agents, chains };
}

function planList(params: ManagementParams, facts: ManagementPlanFacts): ManagementPlan {
	const scope = normalizeListScope(params.agentScope) ?? "both";
	return { ok: true, action: "list", ...scopedList(facts.catalog, scope) };
}

function planGet(params: ManagementParams, facts: ManagementPlanFacts): ManagementPlan {
	if (!params.agent && !params.chainName) return { ok: false, error: "Specify 'agent' or 'chainName' for get." };
	const hasBoth = Boolean(params.agent && params.chainName);
	const items: Extract<ManagementPlan, { action: "get" }>["items"] = [];
	let anyFound = false;
	if (params.agent) {
		const matches = findAgentsInCatalog(params.agent, facts.catalog, "both");
		if (!matches.length) {
			const msg = `Agent '${params.agent}' not found. Available: ${availableNames(facts.catalog, "agent").join(", ") || "none"}.`;
			if (!hasBoth) return { ok: false, error: msg };
			items.push({ kind: "message", text: msg });
		} else {
			anyFound = true;
			items.push(...matches.map((agent) => ({ kind: "agent" as const, agent })));
		}
	}
	if (params.chainName) {
		const matches = findChainsInCatalog(params.chainName, facts.catalog, "both");
		if (!matches.length) {
			const msg = `Chain '${params.chainName}' not found. Available: ${availableNames(facts.catalog, "chain").join(", ") || "none"}.`;
			if (!hasBoth) return { ok: false, error: msg };
			items.push({ kind: "message", text: msg });
		} else {
			anyFound = true;
			items.push(...matches.map((chain) => ({ kind: "chain" as const, chain })));
		}
	}
	return { ok: true, action: "get", items, anyFound };
}

function targetDirForCreate(identity: { scope: ManagementScope; isChain: boolean }, dirs: ManagementDirectories): string {
	if (identity.isChain) return identity.scope === "user" ? dirs.userChainDir : dirs.projectChainDir;
	return identity.scope === "user" ? dirs.userAgentDir : dirs.projectAgentDir;
}

function planCreate(params: ManagementParams, facts: ManagementPlanFacts): ManagementPlan {
	const parsedConfig = configObject(params.config);
	if (parsedConfig.error) return { ok: false, error: parsedConfig.error };
	const cfg = parsedConfig.value;
	if (!cfg) return { ok: false, error: "config required for create." };
	const identity = buildCreateRuntimeIdentity(cfg);
	if (!identity.ok) return identity;
	const { name, packageName, runtimeName, scope, isChain, description } = identity;
	if (nameExistsInCatalog(facts.catalog, scope, runtimeName)) {
		return { ok: false, error: `Name '${runtimeName}' already exists in ${scope} scope. Use update instead.` };
	}
	const targetDir = targetDirForCreate(identity, facts.directories);
	const targetPath = path.join(targetDir, isChain ? `${runtimeName}.chain.md` : `${runtimeName}.md`);
	if (facts.pathExists(targetPath)) {
		return { ok: false, error: `File already exists at ${targetPath} but is not a valid ${isChain ? "chain" : "agent"} definition. Remove or rename it first.` };
	}
	const warnings: string[] = [];
	if (!isChain && facts.catalog.builtin.some((a) => a.name === runtimeName)) warnings.push(`Note: this shadows the builtin agent '${runtimeName}'.`);
	if (isChain) {
		const parsed = parseStepList(cfg.steps);
		if (parsed.error) return { ok: false, error: parsed.error };
		const chain: ChainConfig = { name: runtimeName, localName: name, packageName, description, source: scope, filePath: targetPath, steps: parsed.steps! };
		const missing = unknownChainAgents(facts.catalog, chain.steps);
		if (missing.length) warnings.push(`Warning: chain steps reference unknown agents: ${missing.join(", ")}.`);
		warnings.push(...chainStepWarnings(warningFacts(facts), chain.steps));
		return { ok: true, action: "create", entity: "chain", operation: { type: "write-chain", targetDir, filePath: targetPath, chain }, warnings };
	}
	const agent: AgentConfig = {
		name: runtimeName,
		localName: name,
		packageName,
		description,
		source: scope,
		filePath: targetPath,
		systemPrompt: "",
		systemPromptMode: defaultSystemPromptMode(name),
		inheritProjectContext: defaultInheritProjectContext(name),
		inheritSkills: defaultInheritSkills(),
	};
	const applyError = applyAgentConfig(agent, cfg);
	if (applyError) return { ok: false, error: applyError };
	const warningsCtx = warningFacts(facts);
	const mw = modelWarning(warningsCtx, agent.model);
	if (mw) warnings.push(mw);
	const fmw = fallbackModelsWarning(warningsCtx, agent.fallbackModels);
	if (fmw) warnings.push(fmw);
	const sw = skillsWarning(warningsCtx, agent.skills);
	if (sw) warnings.push(sw);
	return { ok: true, action: "create", entity: "agent", operation: { type: "write-agent", targetDir, filePath: targetPath, agent }, warnings };
}

function renameOperation(
	kind: "agent" | "chain",
	currentPath: string,
	newName: string,
	scope: ManagementScope,
	facts: ManagementPlanFacts,
): { operation?: Extract<ManagementFileOperation, { type: "rename" }>; filePath?: string; error?: string } {
	if (nameExistsInCatalog(facts.catalog, scope, newName, currentPath)) return { error: `Name '${newName}' already exists in ${scope} scope.` };
	const ext = kind === "agent" ? ".md" : ".chain.md";
	const filePath = path.join(path.dirname(currentPath), `${newName}${ext}`);
	if (facts.pathExists(filePath) && filePath !== currentPath) {
		return { error: `File already exists at ${filePath} but is not a valid ${kind} definition. Remove or rename it first.` };
	}
	return { filePath, operation: { type: "rename", kind, from: currentPath, to: filePath } };
}

function planUpdate(params: ManagementParams, facts: ManagementPlanFacts): ManagementPlan {
	if (!params.agent && !params.chainName) return { ok: false, error: "Specify 'agent' or 'chainName' for update." };
	if (params.agent && params.chainName) return { ok: false, error: "Specify either 'agent' or 'chainName', not both." };
	const parsedConfig = configObject(params.config);
	if (parsedConfig.error) return { ok: false, error: parsedConfig.error };
	const cfg = parsedConfig.value;
	if (!cfg) return { ok: false, error: "config required for update." };
	const warnings: string[] = [];
	if (params.agent) {
		const scopeHint = asDisambiguationScope(params.agentScope);
		const targetPlan = resolveTargetPlan("agent", params.agent, findAgentsInCatalog(params.agent, facts.catalog, scopeHint ?? "both"), facts.catalog, params.agentScope);
		if (!targetPlan.ok) return targetPlan;
		const target = targetPlan.target;
		const updated: AgentConfig = { ...target };
		const oldName = target.name;
		const identity = resolveUpdatedIdentity(target, cfg);
		if (identity.error) return { ok: false, error: identity.error };
		const { newLocalName, newPackageName } = identity;
		const applyError = applyAgentConfig(updated, cfg);
		if (applyError) return { ok: false, error: applyError };
		updated.localName = newLocalName;
		updated.packageName = newPackageName;
		updated.name = buildRuntimeName(newLocalName, newPackageName);
		if (hasKey(cfg, "description")) updated.description = (cfg.description as string).trim();
		if (hasKey(cfg, "model")) {
			const mw = modelWarning(warningFacts(facts), updated.model);
			if (mw) warnings.push(mw);
		}
		if (hasKey(cfg, "fallbackModels")) {
			const fmw = fallbackModelsWarning(warningFacts(facts), updated.fallbackModels);
			if (fmw) warnings.push(fmw);
		}
		if (hasKey(cfg, "skills")) {
			const sw = skillsWarning(warningFacts(facts), updated.skills);
			if (sw) warnings.push(sw);
		}
		const operations: ManagementFileOperation[] = [];
		if (updated.name !== oldName) {
			const renamed = renameOperation("agent", target.filePath, updated.name, target.source, facts);
			if (renamed.error) return { ok: false, error: renamed.error };
			operations.push(renamed.operation!);
			updated.filePath = renamed.filePath!;
			const refs = facts.catalog.chains.filter((c) => c.steps.some((s) => s.agent === oldName)).map((c) => `${c.name} (${c.source})`);
			if (refs.length) warnings.push(`Warning: chains still reference '${oldName}': ${refs.join(", ")}.`);
		}
		operations.push({ type: "write-agent", targetDir: path.dirname(updated.filePath), filePath: updated.filePath, agent: updated });
		return { ok: true, action: "update", entity: "agent", oldName, updated, operations, warnings };
	}
	const scopeHint = asDisambiguationScope(params.agentScope);
	const targetPlan = resolveTargetPlan("chain", params.chainName!, findChainsInCatalog(params.chainName!, facts.catalog, scopeHint ?? "both"), facts.catalog, params.agentScope);
	if (!targetPlan.ok) return targetPlan;
	const target = targetPlan.target;
	const updated: ChainConfig = { ...target, steps: [...target.steps] };
	const oldName = target.name;
	const identity = resolveUpdatedIdentity(target, cfg);
	if (identity.error) return { ok: false, error: identity.error };
	const { newLocalName, newPackageName } = identity;
	let parsedSteps: ChainStepConfig[] | undefined;
	if (hasKey(cfg, "steps")) {
		const parsed = parseStepList(cfg.steps);
		if (parsed.error) return { ok: false, error: parsed.error };
		parsedSteps = parsed.steps!;
	}
	updated.localName = newLocalName;
	updated.packageName = newPackageName;
	updated.name = buildRuntimeName(newLocalName, newPackageName);
	if (hasKey(cfg, "description")) updated.description = (cfg.description as string).trim();
	if (parsedSteps) {
		updated.steps = parsedSteps;
		const missing = unknownChainAgents(facts.catalog, updated.steps);
		if (missing.length) warnings.push(`Warning: chain steps reference unknown agents: ${missing.join(", ")}.`);
		warnings.push(...chainStepWarnings(warningFacts(facts), updated.steps));
	}
	const operations: ManagementFileOperation[] = [];
	if (updated.name !== oldName) {
		const renamed = renameOperation("chain", target.filePath, updated.name, target.source, facts);
		if (renamed.error) return { ok: false, error: renamed.error };
		operations.push(renamed.operation!);
		updated.filePath = renamed.filePath!;
	}
	operations.push({ type: "write-chain", targetDir: path.dirname(updated.filePath), filePath: updated.filePath, chain: updated });
	return { ok: true, action: "update", entity: "chain", oldName, updated, operations, warnings };
}

function planDeleteAction(params: ManagementParams, facts: ManagementPlanFacts): ManagementPlan {
	const deletePlan = planDelete(params, facts.catalog);
	if (!deletePlan.ok) return deletePlan;
	if (deletePlan.kind === "agent") {
		return { ok: true, action: "delete", entity: "agent", target: deletePlan.target, operations: [{ type: "delete", kind: "agent", filePath: deletePlan.target.filePath }], warnings: deletePlan.warnings };
	}
	return { ok: true, action: "delete", entity: "chain", target: deletePlan.target, operations: [{ type: "delete", kind: "chain", filePath: deletePlan.target.filePath }], warnings: deletePlan.warnings };
}

export function planManagementAction(action: string, params: ManagementParams, facts: ManagementPlanFacts): ManagementPlan {
	switch (action as ManagementAction) {
		case "list": return planList(params, facts);
		case "get": return planGet(params, facts);
		case "create": return planCreate(params, facts);
		case "update": return planUpdate(params, facts);
		case "delete": return planDeleteAction(params, facts);
		default: return { ok: false, error: `Unknown action: ${action}` };
	}
}
