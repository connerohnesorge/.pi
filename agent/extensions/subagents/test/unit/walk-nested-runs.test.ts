import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { walkNestedRuns } from "../../src/runs/shared/nested-render.ts";
import type { NestedWalkOptions } from "../../src/runs/shared/nested-render.ts";
import type { NestedRunSummary, NestedStepSummary } from "../../src/shared/types.ts";

function run(id: string, state: NestedRunSummary["state"] = "running", extra: Partial<NestedRunSummary> = {}): NestedRunSummary {
	return {
		id,
		parentRunId: "root",
		depth: 1,
		path: [{ runId: "root" }],
		state,
		...extra,
	};
}

function step(agent: string, status: NestedStepSummary["status"] = "running", extra: Partial<NestedStepSummary> = {}): NestedStepSummary {
	return { agent, status, ...extra };
}

// Plain, theme-free renderers that echo the prefix so indentation, ordering, and
// aggregate placement are all assertable from the emitted lines.
function probe(overrides: Partial<NestedWalkOptions> = {}): NestedWalkOptions {
	return {
		maxDepth: 2,
		maxLines: 40,
		renderRun: (r, _depth, prefix) => `${prefix}RUN:${r.id}`,
		renderStep: (s, index, prefix) => `${prefix}STEP:${index}:${s.agent}`,
		renderAggregate: (text, prefix) => `${prefix}AGG:${text}`,
		...overrides,
	};
}

describe("walkNestedRuns", () => {
	it("returns no lines for empty input", () => {
		assert.deepEqual(walkNestedRuns(undefined, probe()), []);
		assert.deepEqual(walkNestedRuns([], probe()), []);
	});

	it("renders a run line per top-level child with the starting indent", () => {
		const lines = walkNestedRuns([run("a"), run("b")], probe({ indent: "  " }));
		assert.deepEqual(lines, ["  RUN:a", "  RUN:b"]);
	});

	it("emits step lines and recurses into step children", () => {
		const tree = [
			run("a", "running", {
				steps: [step("planner"), step("builder", "running", { children: [run("a-child")] })],
			}),
		];
		const lines = walkNestedRuns(tree, probe());
		assert.deepEqual(lines, [
			"RUN:a",
			"  STEP:0:planner",
			"  STEP:1:builder",
			"    RUN:a-child",
		]);
	});

	it("recurses into a run's own children with a two-space indent", () => {
		const tree = [run("a", "running", { children: [run("a-kid", "running", { children: [run("a-grandkid")] })] })];
		const lines = walkNestedRuns(tree, probe());
		assert.deepEqual(lines, [
			"RUN:a",
			"  RUN:a-kid",
			"    RUN:a-grandkid",
		]);
	});

	it("collapses runs deeper than maxDepth into a single aggregate line", () => {
		// depth 0 (a) -> depth 1 (a-kid) -> depth 2 (a-grandkid) -> depth 3 collapses.
		const tree = [
			run("a", "running", {
				children: [
					run("a-kid", "running", {
						children: [
							run("a-grandkid", "running", {
								children: [run("too-deep-1"), run("too-deep-2", "complete")],
							}),
						],
					}),
				],
			}),
		];
		const lines = walkNestedRuns(tree, probe());
		// a-grandkid sits at depth === maxDepth, so its descendants render as the
		// grandchild aggregate (two extra spaces) rather than the depth>maxDepth path.
		assert.deepEqual(lines, [
			"RUN:a",
			"  RUN:a-kid",
			"    RUN:a-grandkid",
			"      AGG:+2 nested runs (1 running, 1 complete)",
		]);
	});

	it("collapses the whole list to one aggregate when entered beyond maxDepth", () => {
		// Drives the depth > maxDepth guard at the top of the traversal.
		const tree = [run("a"), run("b", "failed")];
		const lines = walkNestedRuns(tree, probe({ maxDepth: -1 }));
		assert.deepEqual(lines, ["AGG:+2 nested runs (1 running, 1 failed)"]);
	});

	it("renders the grandchild aggregate at depth === maxDepth and stops recursing", () => {
		// a (0) -> a-kid (1) -> step s -> step children at depth 2 (=== maxDepth);
		// each depth-2 run summarises its own descendants rather than recursing.
		const tree = [
			run("a", "running", {
				children: [
					run("a-kid", "running", {
						steps: [
							step("s", "running", {
								children: [
									run("mid", "running", {
										steps: [step("deep", "running", { children: [run("hidden"), run("hidden-2", "failed")] })],
									}),
								],
							}),
						],
					}),
				],
			}),
		];
		const lines = walkNestedRuns(tree, probe());
		assert.deepEqual(lines, [
			"RUN:a",
			"  RUN:a-kid",
			"    STEP:0:s",
			"      RUN:mid",
			"        AGG:+2 nested runs (1 running, 1 failed)",
		]);
	});

	it("replaces the last line with an aggregate of the remaining runs when the budget overflows", () => {
		const tree = [run("a"), run("b"), run("c", "complete"), run("d", "failed")];
		const lines = walkNestedRuns(tree, probe({ maxLines: 2 }));
		// First two runs render; on the third iteration the budget is hit, so the
		// last emitted line is replaced by an aggregate of items[2..].
		assert.deepEqual(lines, [
			"RUN:a",
			"AGG:+2 nested runs (1 failed, 1 complete)",
		]);
	});

	it("invokes afterRun for the commandHints line and respects the budget", () => {
		const tree = [run("a"), run("b")];
		const lines = walkNestedRuns(tree, probe({
			afterRun: (r, prefix) => `${prefix}  HINT:${r.id}`,
		}));
		assert.deepEqual(lines, [
			"RUN:a",
			"  HINT:a",
			"RUN:b",
			"  HINT:b",
		]);
	});

	it("skips the afterRun hint when the run line already fills the budget", () => {
		// maxLines:1 -> RUN:a fills the budget, so its hint never renders. The next
		// iteration overflows and replaces the line with an aggregate of the rest.
		const single = walkNestedRuns([run("a", "running", { children: [run("a-kid")] })], probe({
			maxLines: 1,
			afterRun: (r, prefix) => `${prefix}  HINT:${r.id}`,
		}));
		assert.deepEqual(single, ["RUN:a"]);

		const overflow = walkNestedRuns([run("a"), run("b")], probe({
			maxLines: 1,
			afterRun: (r, prefix) => `${prefix}  HINT:${r.id}`,
		}));
		assert.deepEqual(overflow, ["AGG:+1 nested run (1 running)"]);
	});

	it("applies postProcess to the final line set", () => {
		const tree = [run("a"), run("b")];
		const lines = walkNestedRuns(tree, probe({
			postProcess: (out) => out.map((line) => `<${line}>`),
		}));
		assert.deepEqual(lines, ["<RUN:a>", "<RUN:b>"]);
	});
});
