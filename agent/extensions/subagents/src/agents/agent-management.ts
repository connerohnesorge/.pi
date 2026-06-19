// fallow-ignore-file code-duplication
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AgentConfig,
	type AgentScope,
	type ChainConfig,
	type ChainStepConfig,
	defaultInheritProjectContext,
	defaultInheritSkills,
	defaultSystemPromptMode,
	discoverAgentsAll,
	buildRuntimeName,
	frontmatterNameForConfig,
} from "./agents.ts";
import { joinToolList } from "./agent-fields.ts";
import { serializeAgent } from "./agent-serializer.ts";
import { serializeChain } from "./chain-serializer.ts";
import { discoverAvailableSkills } from "./skills.ts";
import {
	allAgents,
	applyAgentConfig,
	asDisambiguationScope,
	availableNames,
	buildCreateRuntimeIdentity,
	chainStepWarnings,
	configObject,
	fallbackModelsWarning,
	findAgentsInCatalog,
	findChainsInCatalog,
	hasKey,
	modelWarning,
	nameExistsInCatalog,
	normalizeListScope,
	parseStepList,
	planDelete,
	resolveTargetPlan,
	resolveUpdatedIdentity,
	skillsWarning,
	unknownChainAgents,
	type ManagementAction,
	type ManagementCatalog,
	type ManagementParams,
	type ManagementScope,
	type WarningContext,
} from "./agent-management-planner.ts";
import type { Details } from "../shared/types.ts";

type ManagementContext = Pick<ExtensionContext, "cwd" | "modelRegistry">;

function result(text: string, isError = false): AgentToolResult<Details> {
	return { content: [{ type: "text", text }], isError, details: { mode: "management", results: [] } };
}

function toCatalog(d: ReturnType<typeof discoverAgentsAll>): ManagementCatalog {
	return { builtin: d.builtin, user: d.user, project: d.project, chains: d.chains };
}

function discoverCatalog(cwd: string): { discovery: ReturnType<typeof discoverAgentsAll>; catalog: ManagementCatalog } {
	const discovery = discoverAgentsAll(cwd);
	return { discovery, catalog: toCatalog(discovery) };
}

function warningContext(ctx: ManagementContext): WarningContext {
	return { models: ctx.modelRegistry.getAvailable(), skills: discoverAvailableSkills(ctx.cwd) };
}

function availableNamesForCwd(cwd: string, kind: "agent" | "chain"): string[] {
	return availableNames(discoverCatalog(cwd).catalog, kind);
}

function findAgents(name: string, cwd: string, scope: AgentScope = "both"): AgentConfig[] {
	return findAgentsInCatalog(name, discoverCatalog(cwd).catalog, scope);
}

function findChains(name: string, cwd: string, scope: AgentScope = "both"): ChainConfig[] {
	return findChainsInCatalog(name, discoverCatalog(cwd).catalog, scope);
}

function renamePath(
	kind: "agent" | "chain",
	currentPath: string,
	newName: string,
	scope: ManagementScope,
	catalog: ManagementCatalog,
): { filePath?: string; error?: string } {
	if (nameExistsInCatalog(catalog, scope, newName, currentPath)) return { error: `Name '${newName}' already exists in ${scope} scope.` };
	const ext = kind === "agent" ? ".md" : ".chain.md";
	const filePath = path.join(path.dirname(currentPath), `${newName}${ext}`);
	if (fs.existsSync(filePath) && filePath !== currentPath) {
		return { error: `File already exists at ${filePath} but is not a valid ${kind} definition. Remove or rename it first.` };
	}
	fs.renameSync(currentPath, filePath);
	return { filePath };
}

function formatAgentDetail(agent: AgentConfig): string {
	const tools = joinToolList(agent);
	const lines: string[] = [`Agent: ${agent.name} (${agent.source})`, `Path: ${agent.filePath}`, `Description: ${agent.description}`];
	if (agent.packageName) {
		lines.push(`Local name: ${frontmatterNameForConfig(agent)}`);
		lines.push(`Package: ${agent.packageName}`);
	}
	if (agent.model) lines.push(`Model: ${agent.model}`);
	if (agent.fallbackModels?.length) lines.push(`Fallback models: ${agent.fallbackModels.join(", ")}`);
	if (tools?.length) lines.push(`Tools: ${tools.join(", ")}`);
	if (agent.skills?.length) lines.push(`Skills: ${agent.skills.join(", ")}`);
	lines.push(`System prompt mode: ${agent.systemPromptMode}`);
	lines.push(`Inherit project context: ${agent.inheritProjectContext ? "true" : "false"}`);
	lines.push(`Inherit skills: ${agent.inheritSkills ? "true" : "false"}`);
	if (agent.defaultContext) lines.push(`Default context: ${agent.defaultContext}`);
	if (agent.source === "builtin") lines.push(`Disabled: ${agent.disabled ? "true" : "false"}`);
	if (agent.extensions !== undefined) lines.push(`Extensions: ${agent.extensions.length ? agent.extensions.join(", ") : "(none)"}`);
	if (agent.thinking) lines.push(`Thinking: ${agent.thinking}`);
	if (agent.output) lines.push(`Output: ${agent.output}`);
	if (agent.defaultReads?.length) lines.push(`Reads: ${agent.defaultReads.join(", ")}`);
	if (agent.defaultProgress) lines.push("Progress: true");
	if (agent.maxSubagentDepth !== undefined) lines.push(`Max subagent depth: ${agent.maxSubagentDepth}`);
	if (agent.completionGuard === false) lines.push("Completion guard: false");
	if (agent.systemPrompt.trim()) lines.push("", "System Prompt:", agent.systemPrompt);
	return lines.join("\n");
}

function formatChainDetail(chain: ChainConfig): string {
	const lines: string[] = [`Chain: ${chain.name} (${chain.source})`, `Path: ${chain.filePath}`, `Description: ${chain.description}`];
	if (chain.packageName) {
		lines.push(`Local name: ${frontmatterNameForConfig(chain)}`);
		lines.push(`Package: ${chain.packageName}`);
	}
	lines.push("", "Steps:");
	for (let i = 0; i < chain.steps.length; i++) {
		const s = chain.steps[i]!;
		lines.push(`${i + 1}. ${s.agent}`);
		if (s.task.trim()) lines.push(`   Task: ${s.task}`);
		if (s.output === false) lines.push("   Output: false");
		else if (s.output) lines.push(`   Output: ${s.output}`);
		if (s.outputMode) lines.push(`   Output mode: ${s.outputMode}`);
		if (s.reads === false) lines.push("   Reads: false");
		else if (Array.isArray(s.reads) && s.reads.length > 0) lines.push(`   Reads: ${s.reads.join(", ")}`);
		if (s.model) lines.push(`   Model: ${s.model}`);
		if (s.skills === false) lines.push("   Skills: false");
		else if (Array.isArray(s.skills) && s.skills.length > 0) lines.push(`   Skills: ${s.skills.join(", ")}`);
		if (s.progress !== undefined) lines.push(`   Progress: ${s.progress ? "true" : "false"}`);
	}
	return lines.join("\n");
}

export function handleList(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	const scope = normalizeListScope(params.agentScope) ?? "both";
	const d = discoverAgentsAll(ctx.cwd);
	const scopedAgents = allAgents(d).filter((a) => scope === "both" || a.source === "builtin" || a.source === scope).sort((a, b) => a.name.localeCompare(b.name));
	const agents = scopedAgents.filter((a) => !a.disabled);
	const chains = d.chains.filter((c) => scope === "both" || c.source === scope).sort((a, b) => a.name.localeCompare(b.name));
	const lines = [
		"Executable agents:",
		...(agents.length
			? agents.map((a) => `- ${a.name} (${a.source}${a.defaultContext ? `, context: ${a.defaultContext}` : ""}): ${a.description}`)
			: ["- (none)"]),
		"",
		"Chains:",
		...(chains.length ? chains.map((c) => `- ${c.name} (${c.source}): ${c.description}`) : ["- (none)"]),
	];
	return result(lines.join("\n"));
}

function handleGet(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent && !params.chainName) return result("Specify 'agent' or 'chainName' for get.", true);
	const hasBoth = Boolean(params.agent && params.chainName);
	const blocks: string[] = [];
	let anyFound = false;
	if (params.agent) {
		const matches = findAgents(params.agent, ctx.cwd, "both");
		if (!matches.length) {
			const msg = `Agent '${params.agent}' not found. Available: ${availableNamesForCwd(ctx.cwd, "agent").join(", ") || "none"}.`;
			if (!hasBoth) return result(msg, true);
			blocks.push(msg);
		} else {
			anyFound = true;
			blocks.push(...matches.map(formatAgentDetail));
		}
	}
	if (params.chainName) {
		const matches = findChains(params.chainName, ctx.cwd, "both");
		if (!matches.length) {
			const msg = `Chain '${params.chainName}' not found. Available: ${availableNamesForCwd(ctx.cwd, "chain").join(", ") || "none"}.`;
			if (!hasBoth) return result(msg, true);
			blocks.push(msg);
		} else {
			anyFound = true;
			blocks.push(...matches.map(formatChainDetail));
		}
	}
	return result(blocks.join("\n\n"), !anyFound);
}

export function handleCreate(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	const parsedConfig = configObject(params.config);
	if (parsedConfig.error) return result(parsedConfig.error, true);
	const cfg = parsedConfig.value;
	if (!cfg) return result("config required for create.", true);
	const identity = buildCreateRuntimeIdentity(cfg);
	if (!identity.ok) return result(identity.error, true);
	const { name, packageName, runtimeName, scope, isChain, description } = identity;
	const { discovery: d, catalog } = discoverCatalog(ctx.cwd);
	const targetDir = isChain
		? scope === "user" ? d.userChainDir : d.projectChainDir ?? path.join(ctx.cwd, ".pi", "chains")
		: scope === "user" ? d.userDir : d.projectDir ?? path.join(ctx.cwd, ".pi", "agents");
	fs.mkdirSync(targetDir, { recursive: true });
	if (nameExistsInCatalog(catalog, scope, runtimeName)) return result(`Name '${runtimeName}' already exists in ${scope} scope. Use update instead.`, true);
	const targetPath = path.join(targetDir, isChain ? `${runtimeName}.chain.md` : `${runtimeName}.md`);
	if (fs.existsSync(targetPath)) return result(`File already exists at ${targetPath} but is not a valid ${isChain ? "chain" : "agent"} definition. Remove or rename it first.`, true);
	const warnings: string[] = [];
	if (!isChain && d.builtin.some((a) => a.name === runtimeName)) warnings.push(`Note: this shadows the builtin agent '${runtimeName}'.`);
	if (isChain) {
		const parsed = parseStepList(cfg.steps);
		if (parsed.error) return result(parsed.error, true);
		const chain: ChainConfig = { name: runtimeName, localName: name, packageName, description, source: scope, filePath: targetPath, steps: parsed.steps! };
		fs.writeFileSync(targetPath, serializeChain(chain), "utf-8");
		const missing = unknownChainAgents(catalog, chain.steps);
		if (missing.length) warnings.push(`Warning: chain steps reference unknown agents: ${missing.join(", ")}.`);
		warnings.push(...chainStepWarnings(warningContext(ctx), chain.steps));
		return result([`Created chain '${runtimeName}' at ${targetPath}.`, ...warnings].join("\n"));
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
	if (applyError) return result(applyError, true);
	const warningsCtx = warningContext(ctx);
	const mw = modelWarning(warningsCtx, agent.model);
	if (mw) warnings.push(mw);
	const fmw = fallbackModelsWarning(warningsCtx, agent.fallbackModels);
	if (fmw) warnings.push(fmw);
	const sw = skillsWarning(warningsCtx, agent.skills);
	if (sw) warnings.push(sw);
	fs.writeFileSync(targetPath, serializeAgent(agent), "utf-8");
	return result([`Created agent '${runtimeName}' at ${targetPath}.`, ...warnings].join("\n"));
}

export function handleUpdate(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	if (!params.agent && !params.chainName) return result("Specify 'agent' or 'chainName' for update.", true);
	if (params.agent && params.chainName) return result("Specify either 'agent' or 'chainName', not both.", true);
	const parsedConfig = configObject(params.config);
	if (parsedConfig.error) return result(parsedConfig.error, true);
	const cfg = parsedConfig.value;
	if (!cfg) return result("config required for update.", true);
	const warnings: string[] = [];
	const { catalog } = discoverCatalog(ctx.cwd);
	let cachedWarningsCtx: WarningContext | undefined;
	const getWarningsCtx = (): WarningContext => cachedWarningsCtx ??= warningContext(ctx);
	if (params.agent) {
		const scopeHint = asDisambiguationScope(params.agentScope);
		const targetPlan = resolveTargetPlan("agent", params.agent, findAgentsInCatalog(params.agent, catalog, scopeHint ?? "both"), catalog, params.agentScope);
		if (!targetPlan.ok) return result(targetPlan.error, true);
		const target = targetPlan.target;
		const updated: AgentConfig = { ...target };
		const oldName = target.name;
		const identity = resolveUpdatedIdentity(target, cfg);
		if (identity.error) return result(identity.error, true);
		const { newLocalName, newPackageName } = identity;
		const applyError = applyAgentConfig(updated, cfg);
		if (applyError) return result(applyError, true);
		updated.localName = newLocalName;
		updated.packageName = newPackageName;
		updated.name = buildRuntimeName(newLocalName, newPackageName);
		if (hasKey(cfg, "description")) updated.description = (cfg.description as string).trim();
		if (hasKey(cfg, "model")) {
			const mw = modelWarning(getWarningsCtx(), updated.model);
			if (mw) warnings.push(mw);
		}
		if (hasKey(cfg, "fallbackModels")) {
			const fmw = fallbackModelsWarning(getWarningsCtx(), updated.fallbackModels);
			if (fmw) warnings.push(fmw);
		}
		if (hasKey(cfg, "skills")) {
			const sw = skillsWarning(getWarningsCtx(), updated.skills);
			if (sw) warnings.push(sw);
		}
		if (updated.name !== oldName) {
			const renamed = renamePath("agent", target.filePath, updated.name, target.source, catalog);
			if (renamed.error) return result(renamed.error, true);
			updated.filePath = renamed.filePath!;
		}
		fs.writeFileSync(updated.filePath, serializeAgent(updated), "utf-8");
		if (updated.name !== oldName) {
			const refs = discoverAgentsAll(ctx.cwd).chains.filter((c) => c.steps.some((s) => s.agent === oldName)).map((c) => `${c.name} (${c.source})`);
			if (refs.length) warnings.push(`Warning: chains still reference '${oldName}': ${refs.join(", ")}.`);
		}
		const headline = updated.name === oldName
			? `Updated agent '${updated.name}' at ${updated.filePath}.`
			: `Updated agent '${oldName}' to '${updated.name}' at ${updated.filePath}.`;
		return result([headline, ...warnings].join("\n"));
	}
	const scopeHint = asDisambiguationScope(params.agentScope);
	const targetPlan = resolveTargetPlan("chain", params.chainName!, findChainsInCatalog(params.chainName!, catalog, scopeHint ?? "both"), catalog, params.agentScope);
	if (!targetPlan.ok) return result(targetPlan.error, true);
	const target = targetPlan.target;
	const updated: ChainConfig = { ...target, steps: [...target.steps] };
	const oldName = target.name;
	const identity = resolveUpdatedIdentity(target, cfg);
	if (identity.error) return result(identity.error, true);
	const { newLocalName, newPackageName } = identity;
	let parsedSteps: ChainStepConfig[] | undefined;
	if (hasKey(cfg, "steps")) {
		const parsed = parseStepList(cfg.steps);
		if (parsed.error) return result(parsed.error, true);
		parsedSteps = parsed.steps!;
	}
	updated.localName = newLocalName;
	updated.packageName = newPackageName;
	updated.name = buildRuntimeName(newLocalName, newPackageName);
	if (hasKey(cfg, "description")) updated.description = (cfg.description as string).trim();
	if (parsedSteps) {
		updated.steps = parsedSteps;
		const missing = unknownChainAgents(catalog, updated.steps);
		if (missing.length) warnings.push(`Warning: chain steps reference unknown agents: ${missing.join(", ")}.`);
		warnings.push(...chainStepWarnings(getWarningsCtx(), updated.steps));
	}
	if (updated.name !== oldName) {
		const renamed = renamePath("chain", target.filePath, updated.name, target.source, catalog);
		if (renamed.error) return result(renamed.error, true);
		updated.filePath = renamed.filePath!;
	}
	fs.writeFileSync(updated.filePath, serializeChain(updated), "utf-8");
	const headline = updated.name === oldName
		? `Updated chain '${updated.name}' at ${updated.filePath}.`
		: `Updated chain '${oldName}' to '${updated.name}' at ${updated.filePath}.`;
	return result([headline, ...warnings].join("\n"));
}

function handleDelete(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	const plan = planDelete(params, discoverCatalog(ctx.cwd).catalog);
	if (!plan.ok) return result(plan.error, true);
	fs.unlinkSync(plan.target.filePath);
	return result(plan.lines.join("\n"));
}

export function handleManagementAction(action: string, params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	switch (action as ManagementAction) {
		case "list": return handleList(params, ctx);
		case "get": return handleGet(params, ctx);
		case "create": return handleCreate(params, ctx);
		case "update": return handleUpdate(params, ctx);
		case "delete": return handleDelete(params, ctx);
		default: return result(`Unknown action: ${action}`, true);
	}
}
