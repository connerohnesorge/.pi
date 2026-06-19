// fallow-ignore-file code-duplication
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AgentConfig,
	type ChainConfig,
	discoverAgentsAll,
	frontmatterNameForConfig,
} from "./agents.ts";
import { joinToolList } from "./agent-fields.ts";
import { serializeAgent } from "./agent-serializer.ts";
import { serializeChain } from "./chain-serializer.ts";
import { discoverAvailableSkills } from "./skills.ts";
import {
	planManagementAction,
	type ManagementCatalog,
	type ManagementFileOperation,
	type ManagementParams,
	type ManagementPlan,
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

function buildPlanFacts(ctx: ManagementContext) {
	const { discovery, catalog } = discoverCatalog(ctx.cwd);
	let cachedWarnings: WarningContext | undefined;
	return {
		catalog,
		directories: {
			cwd: ctx.cwd,
			userAgentDir: discovery.userDir,
			projectAgentDir: discovery.projectDir ?? path.join(ctx.cwd, ".pi", "agents"),
			userChainDir: discovery.userChainDir,
			projectChainDir: discovery.projectChainDir ?? path.join(ctx.cwd, ".pi", "chains"),
		},
		warnings: () => cachedWarnings ??= warningContext(ctx),
		pathExists: (filePath: string) => fs.existsSync(filePath),
	};
}

function applyManagementOperation(operation: ManagementFileOperation): void {
	switch (operation.type) {
		case "rename":
			fs.renameSync(operation.from, operation.to);
			return;
		case "write-agent":
			fs.mkdirSync(operation.targetDir, { recursive: true });
			fs.writeFileSync(operation.filePath, serializeAgent(operation.agent), "utf-8");
			return;
		case "write-chain":
			fs.mkdirSync(operation.targetDir, { recursive: true });
			fs.writeFileSync(operation.filePath, serializeChain(operation.chain), "utf-8");
			return;
		case "delete":
			fs.unlinkSync(operation.filePath);
			return;
	}
}

function applyManagementPlan(plan: ManagementPlan): void {
	if (!plan.ok) return;
	if ("operations" in plan) {
		for (const operation of plan.operations) applyManagementOperation(operation);
		return;
	}
	if (plan.action === "create") {
		applyManagementOperation(plan.operation);
	}
}

function formatListPlan(plan: Extract<ManagementPlan, { action: "list" }>): string {
	const lines = [
		"Executable agents:",
		...(plan.agents.length
			? plan.agents.map((a) => `- ${a.name} (${a.source}${a.defaultContext ? `, context: ${a.defaultContext}` : ""}): ${a.description}`)
			: ["- (none)"]),
		"",
		"Chains:",
		...(plan.chains.length ? plan.chains.map((c) => `- ${c.name} (${c.source}): ${c.description}`) : ["- (none)"]),
	];
	return lines.join("\n");
}

function formatGetPlan(plan: Extract<ManagementPlan, { action: "get" }>): string {
	return plan.items.map((item) => {
		if (item.kind === "agent") return formatAgentDetail(item.agent);
		if (item.kind === "chain") return formatChainDetail(item.chain);
		return item.text;
	}).join("\n\n");
}

function formatCreatePlan(plan: Extract<ManagementPlan, { action: "create" }>): string {
	const headline = plan.entity === "agent"
		? `Created agent '${plan.operation.agent.name}' at ${plan.operation.filePath}.`
		: `Created chain '${plan.operation.chain.name}' at ${plan.operation.filePath}.`;
	return [headline, ...plan.warnings].join("\n");
}

function formatUpdatePlan(plan: Extract<ManagementPlan, { action: "update" }>): string {
	const headline = plan.entity === "agent"
		? plan.updated.name === plan.oldName
			? `Updated agent '${plan.updated.name}' at ${plan.updated.filePath}.`
			: `Updated agent '${plan.oldName}' to '${plan.updated.name}' at ${plan.updated.filePath}.`
		: plan.updated.name === plan.oldName
			? `Updated chain '${plan.updated.name}' at ${plan.updated.filePath}.`
			: `Updated chain '${plan.oldName}' to '${plan.updated.name}' at ${plan.updated.filePath}.`;
	return [headline, ...plan.warnings].join("\n");
}

function formatDeletePlan(plan: Extract<ManagementPlan, { action: "delete" }>): string {
	const headline = plan.entity === "agent"
		? `Deleted agent '${plan.target.name}' at ${plan.target.filePath}.`
		: `Deleted chain '${plan.target.name}' at ${plan.target.filePath}.`;
	return [headline, ...plan.warnings].join("\n");
}

function formatManagementPlan(plan: ManagementPlan): string {
	if (!plan.ok) return plan.error;
	switch (plan.action) {
		case "list": return formatListPlan(plan);
		case "get": return formatGetPlan(plan);
		case "create": return formatCreatePlan(plan);
		case "update": return formatUpdatePlan(plan);
		case "delete": return formatDeletePlan(plan);
	}
}

function executeManagementPlan(plan: ManagementPlan): AgentToolResult<Details> {
	if (!plan.ok) return result(plan.error, true);
	applyManagementPlan(plan);
	return result(formatManagementPlan(plan), plan.action === "get" ? !plan.anyFound : false);
}

export function handleList(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	return executeManagementPlan(planManagementAction("list", params, buildPlanFacts(ctx)));
}

function handleGet(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	return executeManagementPlan(planManagementAction("get", params, buildPlanFacts(ctx)));
}

export function handleCreate(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	return executeManagementPlan(planManagementAction("create", params, buildPlanFacts(ctx)));
}

export function handleUpdate(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	return executeManagementPlan(planManagementAction("update", params, buildPlanFacts(ctx)));
}

function handleDelete(params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	return executeManagementPlan(planManagementAction("delete", params, buildPlanFacts(ctx)));
}

export function handleManagementAction(action: string, params: ManagementParams, ctx: ManagementContext): AgentToolResult<Details> {
	return executeManagementPlan(planManagementAction(action, params, buildPlanFacts(ctx)));
}
