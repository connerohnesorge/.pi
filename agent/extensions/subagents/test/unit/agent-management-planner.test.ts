import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { AgentConfig, ChainConfig } from "../../src/agents/agents.ts";
import {
	applyAgentConfig,
	buildCreateRuntimeIdentity,
	chainStepWarnings,
	configObject,
	findAgentsInCatalog,
	nameExistsInCatalog,
	parseStepList,
	planDelete,
	resolveTargetPlan,
	resolveUpdatedIdentity,
	type ManagementCatalog,
} from "../../src/agents/agent-management-planner.ts";

function agent(overrides: Partial<AgentConfig> & Pick<AgentConfig, "name" | "source" | "filePath">): AgentConfig {
	return {
		description: "agent",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		...overrides,
	};
}

function chain(overrides: Partial<ChainConfig> & Pick<ChainConfig, "name" | "source" | "filePath">): ChainConfig {
	return {
		description: "chain",
		steps: [],
		...overrides,
	};
}

function catalog(overrides: Partial<ManagementCatalog> = {}): ManagementCatalog {
	return {
		builtin: [agent({ name: "reviewer", source: "builtin", filePath: "builtin/reviewer.md" })],
		user: [agent({ name: "worker", source: "user", filePath: "user/worker.md" })],
		project: [agent({ name: "worker", source: "project", filePath: "project/worker.md" })],
		chains: [chain({ name: "flow", source: "project", filePath: "project/flow.chain.md", steps: [{ agent: "worker", task: "go" }] })],
		...overrides,
	};
}

describe("agent management planner", () => {
	it("parses config strings and create identities without filesystem effects", () => {
		assert.match(configObject('{"name":').error ?? "", /config must be valid JSON/);
		const parsed = configObject('{"name":"Scout","package":"Code Analysis","description":"Fast recon","scope":"project"}');
		assert.ok(parsed.value);
		assert.deepEqual(buildCreateRuntimeIdentity(parsed.value), {
			ok: true,
			name: "scout",
			packageName: "code-analysis",
			runtimeName: "code-analysis.scout",
			scope: "project",
			isChain: false,
			description: "Fast recon",
		});
	});

	it("validates and applies agent config without writing files", () => {
		const target = agent({ name: "worker", source: "project", filePath: "project/worker.md" });
		const error = applyAgentConfig(target, {
			model: "test/model",
			fallbackModels: "a, b, a",
			tools: "read, mcp:server/tool",
			skills: "review, review, docs",
			completionGuard: false,
		});

		assert.equal(error, undefined);
		assert.equal(target.model, "test/model");
		assert.deepEqual(target.fallbackModels, ["a", "b"]);
		assert.deepEqual(target.tools, ["read"]);
		assert.deepEqual(target.mcpDirectTools, ["server/tool"]);
		assert.deepEqual(target.skills, ["review", "docs"]);
		assert.equal(target.completionGuard, false);
		assert.match(applyAgentConfig(target, { completionGuard: "false" }) ?? "", /must be a boolean/);
	});

	it("plans target resolution and deletion without deleting files", () => {
		const c = catalog();
		const ambiguous = resolveTargetPlan("agent", "worker", findAgentsInCatalog("worker", c), c);
		assert.deepEqual(ambiguous, {
			ok: false,
			error: "Agent 'worker' exists in both scopes. Specify agentScope: 'user' or 'project'.\nproject: project/worker.md\nuser: user/worker.md",
		});

		const scoped = resolveTargetPlan("agent", "worker", findAgentsInCatalog("worker", c, "project"), c, "project");
		assert.equal(scoped.ok, true);
		if (scoped.ok) assert.equal(scoped.target.filePath, "project/worker.md");

		const deletePlan = planDelete({ agent: "worker", agentScope: "project" }, c);
		assert.equal(deletePlan.ok, true);
		if (deletePlan.ok) {
			assert.equal(deletePlan.target.filePath, "project/worker.md");
			assert.deepEqual(deletePlan.lines, [
				"Deleted agent 'worker' at project/worker.md.",
				"Warning: chains reference deleted agent 'worker': flow (project).",
			]);
		}
	});

	it("plans chain-step validation and warnings from supplied catalog facts", () => {
		const parsed = parseStepList([
			{ agent: "worker", task: "ok", model: "known/model", skills: ["known"] },
			{ agent: "missing", output: false, reads: ["one.md"], progress: true, model: "missing/model", skills: ["missing-skill"] },
		]);

		assert.ok(parsed.steps);
		assert.equal(parsed.steps[1]?.agent, "missing");
		assert.equal(nameExistsInCatalog(catalog(), "project", "flow"), true);
		assert.deepEqual(chainStepWarnings({ models: [{ provider: "known", id: "model" }], skills: [{ name: "known" }] }, parsed.steps), [
			"Warning: step 2 (missing): model 'missing/model' is not in the current model registry.",
			"Warning: step 2 (missing): skills not found: missing-skill.",
		]);
	});

	it("resolves updated identity and rejects invalid package/name changes", () => {
		const target = agent({ name: "pkg.worker", localName: "worker", packageName: "pkg", source: "project", filePath: "project/pkg.worker.md" });
		assert.deepEqual(resolveUpdatedIdentity(target, { name: "Scout", package: false }), {
			newLocalName: "scout",
			newPackageName: undefined,
		});
		assert.match(resolveUpdatedIdentity(target, { description: "" }).error ?? "", /description must be a non-empty string/);
	});
});
