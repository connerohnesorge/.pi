import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AgentConfig } from "../../src/agents/agents.ts";
import {
	getStepAgents,
	resolveChainTemplates,
	resolveParallelBehaviors,
	resolveStepBehavior,
	suppressProgressForReadOnlyTask,
	taskDisallowsFileUpdates,
	type ChainStep,
} from "../../src/shared/chain-behavior.ts";
import { buildChainInstructions } from "../../src/shared/chain-instructions.ts";
import { createChainDir, createParallelDirs, writeInitialProgressFile } from "../../src/shared/chain-run-dir.ts";
import * as settings from "../../src/shared/settings.ts";

function agent(overrides: Partial<AgentConfig> & Pick<AgentConfig, "name">): AgentConfig {
	return {
		description: "agent",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: `${overrides.name}.md`,
		...overrides,
	};
}

describe("chain behavior modules", () => {
	it("resolves templates and agent names without filesystem effects", () => {
		const steps: ChainStep[] = [
			{ agent: "scout" },
			{ parallel: [{ agent: "worker" }, { agent: "reviewer", task: "review" }] },
			{ agent: "summarizer", task: "summarize {previous}" },
		];

		assert.deepEqual(resolveChainTemplates(steps), ["{task}", ["{previous}", "review"], "summarize {previous}"]);
		assert.deepEqual(steps.map(getStepAgents), [["scout"], ["worker", "reviewer"], ["summarizer"]]);
	});

	it("resolves step and parallel behavior policy without run directories", () => {
		const worker = agent({ name: "worker", output: "report.md", defaultReads: ["input.md"], defaultProgress: true, skills: ["base"], model: "test/model" });
		const behavior = resolveStepBehavior(worker, { output: "custom.md", skills: ["override"], progress: false }, ["chain-skill"]);

		assert.deepEqual(behavior, {
			output: "custom.md",
			outputMode: "inline",
			reads: ["input.md"],
			progress: false,
			skills: ["override", "chain-skill"],
			model: "test/model",
		});

		const parallel = resolveParallelBehaviors(
			[{ agent: "worker", output: "out.md", skill: "parallel-skill" }],
			[worker],
			2,
			["chain-skill"],
		);
		assert.equal(parallel[0]?.output, path.join("parallel-2", "0-worker", "out.md"));
		assert.deepEqual(parallel[0]?.skills, ["parallel-skill", "chain-skill"]);
	});

	it("suppresses progress for read-only tasks before instruction rendering", () => {
		assert.equal(taskDisallowsFileUpdates("review-only pass, do not edit files"), true);
		assert.equal(suppressProgressForReadOnlyTask({ output: false, outputMode: "inline", reads: false, progress: true, skills: [] }, "audit {task}", "no edits").progress, false);
	});

	it("renders chain instructions separately from behavior policy", () => {
		const instructions = buildChainInstructions(
			{ output: "out.md", outputMode: "inline", reads: ["in.md"], progress: true, skills: [] },
			"/tmp/chain",
			false,
			"previous",
		);

		assert.equal(instructions.prefix, "[Read from: /tmp/chain/in.md]\n[Write to: /tmp/chain/out.md]\n\n");
		assert.equal(instructions.suffix, "\n\n---\nUpdate progress at: /tmp/chain/progress.md\nPrevious step output:\nprevious");
	});

	it("keeps filesystem lifecycle in the run-dir adapter and settings facade compatible", () => {
		const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-chain-run-dir-"));
		try {
			const chainDir = createChainDir("run-1", base);
			writeInitialProgressFile(chainDir);
			createParallelDirs(chainDir, 3, 2, ["worker", "reviewer"]);

			assert.equal(fs.existsSync(path.join(chainDir, "progress.md")), true);
			assert.equal(fs.existsSync(path.join(chainDir, "parallel-3", "0-worker")), true);
			assert.equal(settings.createChainDir("run-2", base), path.join(base, "run-2"));
			assert.equal(settings.buildChainInstructions, buildChainInstructions);
			assert.equal(settings.resolveStepBehavior, resolveStepBehavior);
			assert.equal(typeof settings.cleanupOldChainDirs, "function");
			assert.equal(typeof settings.removeChainDir, "function");
			assert.equal(typeof settings.resolveChainTemplates, "function");
			assert.equal(typeof settings.resolveParallelBehaviors, "function");
		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});
});
