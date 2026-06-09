import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveForegroundRunModel } from "../../src/tui/render-model.ts";
import {
	buildChainStepSpansFromLabels,
	buildChainStepSpansFromGroups,
	parseParallelGroupAgentCount,
} from "../../src/tui/chain-spans.ts";
import type { AgentProgress, Details, SingleResult } from "../../src/shared/types.ts";

type ProgressOverrides = Partial<AgentProgress> & Pick<AgentProgress, "index" | "agent" | "status">;

function progress(overrides: ProgressOverrides): AgentProgress {
	return {
		task: "task",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		...overrides,
	};
}

function result(overrides: Partial<SingleResult> & Pick<SingleResult, "agent">): SingleResult {
	return {
		task: "task",
		exitCode: 0,
		usage: { input: 0, output: 0, total: 0 } as SingleResult["usage"],
		...overrides,
	};
}

function details(overrides: Partial<Details> & Pick<Details, "mode" | "results">): Parameters<typeof deriveForegroundRunModel>[0] {
	return overrides;
}

describe("deriveForegroundRunModel — parallel branch", () => {
	it("reports total, done, and running counts from the model", () => {
		const model = deriveForegroundRunModel(details({
			mode: "parallel",
			totalSteps: 3,
			results: [
				result({ agent: "scout", progress: progress({ index: 0, agent: "scout", status: "running" }) }),
				result({ agent: "reviewer", progress: progress({ index: 1, agent: "reviewer", status: "running" }) }),
				result({ agent: "worker", progress: progress({ index: 2, agent: "worker", status: "running" }) }),
			],
			progress: [
				progress({ index: 0, agent: "scout", status: "running" }),
				progress({ index: 1, agent: "reviewer", status: "running" }),
				progress({ index: 2, agent: "worker", status: "running" }),
			],
		}), true);

		assert.equal(model.itemTitle, "Agent");
		assert.equal(model.totalCount, 3);
		assert.equal(model.header, "3 agents running · 0/3 done");
		assert.equal(model.activeGroup, undefined);
		assert.deepEqual(model.rows.map((row) => row.status), ["running", "running", "running"]);
		assert.deepEqual(model.rows.map((row) => row.done), [false, false, false]);
		assert.deepEqual(model.rows.map((row) => row.label), ["Agent 1/3", "Agent 2/3", "Agent 3/3"]);
	});

	it("counts completed rows for the done total without running wording when settled", () => {
		const model = deriveForegroundRunModel(details({
			mode: "parallel",
			totalSteps: 2,
			results: [
				result({ agent: "scout", exitCode: 0 }),
				result({ agent: "reviewer", exitCode: 1 }),
			],
		}), false);

		assert.equal(model.header, "1/2 done");
		assert.deepEqual(model.rows.map((row) => row.status), ["completed", "failed"]);
		assert.deepEqual(model.rows.map((row) => row.done), [true, false]);
	});
});

describe("deriveForegroundRunModel — active parallel-group branch", () => {
	it("derives the active group window, counts, and local agent labels", () => {
		const model = deriveForegroundRunModel(details({
			mode: "chain",
			chainAgents: ["scout", "[reviewer + auditor]"],
			totalSteps: 2,
			currentStepIndex: 1,
			results: [
				result({ agent: "scout", progress: progress({ index: 0, agent: "scout", status: "completed" }) }),
				result({ agent: "reviewer", progress: progress({ index: 1, agent: "reviewer", status: "running" }) }),
				result({ agent: "auditor", progress: progress({ index: 2, agent: "auditor", status: "completed" }) }),
			],
			progress: [
				progress({ index: 0, agent: "scout", status: "completed" }),
				progress({ index: 1, agent: "reviewer", status: "running" }),
				progress({ index: 2, agent: "auditor", status: "completed" }),
			],
		}), true);

		assert.equal(model.itemTitle, "Agent");
		assert.deepEqual(model.activeGroup, { start: 1, end: 3 });
		assert.equal(model.totalCount, 2);
		assert.equal(model.header, "step 2/2 · parallel group: 1 agent running · 1/2 done");
		// Rows inside the active group get local Agent N/<groupSize> labels.
		assert.equal(model.rows[1]!.label, "Agent 1/2");
		assert.equal(model.rows[2]!.label, "Agent 2/2");
	});
});

describe("deriveForegroundRunModel — chain branch", () => {
	it("reports logical step spans and current/done step counts", () => {
		const model = deriveForegroundRunModel(details({
			mode: "chain",
			chainAgents: ["scout", "planner", "writer"],
			totalSteps: 3,
			currentStepIndex: 2,
			results: [
				result({ agent: "scout", progress: progress({ index: 0, agent: "scout", status: "completed" }) }),
				result({ agent: "planner", progress: progress({ index: 1, agent: "planner", status: "completed" }) }),
				result({ agent: "writer", progress: progress({ index: 2, agent: "writer", status: "running" }) }),
			],
		}), true);

		assert.equal(model.itemTitle, "Step");
		assert.equal(model.totalCount, 3);
		assert.equal(model.hasParallelInChain, false);
		assert.equal(model.header, "step 3/3");
		assert.deepEqual(model.spans, [
			{ stepIndex: 0, start: 0, count: 1, isParallel: false },
			{ stepIndex: 1, start: 1, count: 1, isParallel: false },
			{ stepIndex: 2, start: 2, count: 1, isParallel: false },
		]);
		assert.deepEqual(model.rows.map((row) => row.label), ["Step 1", "Step 2", "Step 3"]);
		assert.deepEqual(model.rows.map((row) => row.status), ["completed", "completed", "running"]);
	});

	it("counts done logical steps when not running", () => {
		const model = deriveForegroundRunModel(details({
			mode: "chain",
			chainAgents: ["scout", "planner"],
			totalSteps: 2,
			results: [
				result({ agent: "scout", exitCode: 0 }),
				result({ agent: "planner", exitCode: 0 }),
			],
		}), false);

		assert.equal(model.header, "step 2/2");
	});

	it("labels chain rows by logical step and parallel group when the chain contains a parallel group", () => {
		const model = deriveForegroundRunModel(details({
			mode: "chain",
			chainAgents: ["scout", "[reviewer + auditor]", "writer"],
			totalSteps: 3,
			results: [
				result({ agent: "scout" }),
				result({ agent: "reviewer" }),
				result({ agent: "auditor" }),
				result({ agent: "writer" }),
			],
		}), true);

		assert.equal(model.hasParallelInChain, true);
		assert.deepEqual(model.rows.map((row) => row.label), ["Step 1", "Agent 1/2", "Agent 2/2", "Step 3"]);
	});
});

describe("deriveForegroundRunModel — single/default branch", () => {
	it("falls back to result-derived step counts when no chainAgents are present", () => {
		const model = deriveForegroundRunModel(details({
			mode: "chain",
			totalSteps: 2,
			results: [
				result({ agent: "scout", exitCode: 0 }),
				result({ agent: "planner", exitCode: 1 }),
			],
		}), false);

		assert.equal(model.itemTitle, "Step");
		assert.equal(model.totalCount, 2);
		assert.equal(model.header, "step 1/2");
		assert.deepEqual(model.rows.map((row) => row.label), ["Step 1", "Step 2"]);
		assert.deepEqual(model.rows.map((row) => row.done), [true, false]);
	});
});

describe("chain-spans shared builder", () => {
	it("parses parallel-group agent counts from labels", () => {
		assert.equal(parseParallelGroupAgentCount("scout"), undefined);
		assert.equal(parseParallelGroupAgentCount("[reviewer + auditor]"), 2);
		assert.equal(parseParallelGroupAgentCount("[solo]"), 1);
		assert.equal(parseParallelGroupAgentCount("[]"), 0);
	});

	it("produces identical ChainStepSpan[] from labels and from a parallel-groups array", () => {
		const fromLabels = buildChainStepSpansFromLabels(["scout", "[reviewer + auditor]", "writer"]);
		const fromGroups = buildChainStepSpansFromGroups(3, 4, [{ start: 1, count: 2, stepIndex: 1 }]);

		assert.deepEqual(fromLabels, [
			{ stepIndex: 0, start: 0, count: 1, isParallel: false },
			{ stepIndex: 1, start: 1, count: 2, isParallel: true },
			{ stepIndex: 2, start: 3, count: 1, isParallel: false },
		]);
		assert.deepEqual(fromGroups, fromLabels);
	});

	it("returns an empty span list for an empty label array", () => {
		assert.deepEqual(buildChainStepSpansFromLabels(undefined), []);
		assert.deepEqual(buildChainStepSpansFromLabels([]), []);
	});

	it("marks trailing flat steps beyond the step count as zero-width in the group-array builder", () => {
		// A leading parallel group of 3 consumes flat indices 0..2; the remaining
		// logical step has no flat slot left, so its span count is 0.
		const spans = buildChainStepSpansFromGroups(2, 3, [{ start: 0, count: 3, stepIndex: 0 }]);
		assert.deepEqual(spans, [
			{ stepIndex: 0, start: 0, count: 3, isParallel: true },
			{ stepIndex: 1, start: 3, count: 0, isParallel: false },
		]);
	});
});
