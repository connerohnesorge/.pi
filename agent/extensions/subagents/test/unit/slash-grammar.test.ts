import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	extractExecutionFlags,
	parseAgentArgs,
	parseAgentToken,
	parseInlineConfig,
} from "../../src/slash/slash-grammar.ts";

describe("parseInlineConfig", () => {
	it("parses output as a string value", () => {
		assert.deepEqual(parseInlineConfig("output=notes.md"), { output: "notes.md" });
	});

	it("parses output=false as the boolean false", () => {
		assert.deepEqual(parseInlineConfig("output=false"), { output: false });
	});

	it("parses outputMode=inline", () => {
		assert.deepEqual(parseInlineConfig("outputMode=inline"), { outputMode: "inline" });
	});

	it("parses outputMode=file-only", () => {
		assert.deepEqual(parseInlineConfig("outputMode=file-only"), { outputMode: "file-only" });
	});

	it("ignores an invalid outputMode value", () => {
		assert.deepEqual(parseInlineConfig("outputMode=bogus"), {});
	});

	it("parses reads as a +-separated list", () => {
		assert.deepEqual(parseInlineConfig("reads=a.ts+b.ts"), { reads: ["a.ts", "b.ts"] });
	});

	it("parses reads=false as the boolean false", () => {
		assert.deepEqual(parseInlineConfig("reads=false"), { reads: false });
	});

	it("treats an empty model value as undefined", () => {
		const config = parseInlineConfig("model=");
		assert.equal(config.model, undefined);
		assert.equal("model" in config, true);
	});

	it("parses skill as a +-separated list", () => {
		assert.deepEqual(parseInlineConfig("skill=review+lint"), { skill: ["review", "lint"] });
	});

	it("treats skills as an alias for skill", () => {
		assert.deepEqual(parseInlineConfig("skills=review+lint"), { skill: ["review", "lint"] });
	});

	it("parses skill=false as the boolean false", () => {
		assert.deepEqual(parseInlineConfig("skill=false"), { skill: false });
	});

	it("treats a bare progress flag as true", () => {
		assert.deepEqual(parseInlineConfig("progress"), { progress: true });
	});

	it("parses progress=false as false", () => {
		assert.deepEqual(parseInlineConfig("progress=false"), { progress: false });
	});

	it("parses progress=<anything-else> as true", () => {
		assert.deepEqual(parseInlineConfig("progress=yes"), { progress: true });
	});

	it("skips empty and blank parts", () => {
		assert.deepEqual(parseInlineConfig(""), {});
		assert.deepEqual(parseInlineConfig("  ,  ,"), {});
	});

	it("ignores unknown keys", () => {
		assert.deepEqual(parseInlineConfig("bogus=1,output=x"), { output: "x" });
	});

	it("parses a combination of keys", () => {
		assert.deepEqual(
			parseInlineConfig("output=notes.md,reads=a.ts+b.ts,model=opus,progress"),
			{ output: "notes.md", reads: ["a.ts", "b.ts"], model: "opus", progress: true },
		);
	});
});

describe("parseAgentToken", () => {
	it("returns an empty config when there is no bracket", () => {
		assert.deepEqual(parseAgentToken("scout"), { name: "scout", config: {} });
	});

	it("parses an inline config block", () => {
		assert.deepEqual(parseAgentToken("worker[output=file]"), {
			name: "worker",
			config: { output: "file" },
		});
	});

	it("parses an unterminated bracket to end of token", () => {
		assert.deepEqual(parseAgentToken("worker[output=file"), {
			name: "worker",
			config: { output: "file" },
		});
	});

	it("returns an empty config for an empty bracket", () => {
		assert.deepEqual(parseAgentToken("worker[]"), { name: "worker", config: {} });
	});
});

describe("extractExecutionFlags", () => {
	it("returns the arguments unchanged when no flags are present", () => {
		assert.deepEqual(extractExecutionFlags('scout "look around"'), {
			args: 'scout "look around"',
			bg: false,
			fork: false,
		});
	});

	it("strips a trailing --bg", () => {
		assert.deepEqual(extractExecutionFlags('scout "look around" --bg'), {
			args: 'scout "look around"',
			bg: true,
			fork: false,
		});
	});

	it("strips a trailing --fork", () => {
		assert.deepEqual(extractExecutionFlags('scout "look around" --fork'), {
			args: 'scout "look around"',
			bg: false,
			fork: true,
		});
	});

	it("strips both trailing flags", () => {
		assert.deepEqual(extractExecutionFlags('scout "look around" --bg --fork'), {
			args: 'scout "look around"',
			bg: true,
			fork: true,
		});
	});

	it("handles an exact --bg input", () => {
		assert.deepEqual(extractExecutionFlags("--bg"), { args: "", bg: true, fork: false });
	});

	it("handles repeated and interleaved flags", () => {
		assert.deepEqual(extractExecutionFlags('scout "x" --fork --bg --fork'), {
			args: 'scout "x"',
			bg: true,
			fork: true,
		});
	});

	it("handles a flags-only input", () => {
		assert.deepEqual(extractExecutionFlags("--bg --fork"), { args: "", bg: true, fork: true });
	});
});

describe("parseAgentArgs", () => {
	it("parses an arrow chain with double- and single-quoted per-step tasks", () => {
		const result = parseAgentArgs(`scout "recon" -> planner 'plan it'`, "chain");
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(
			result.steps.map(({ name, task }) => ({ name, task })),
			[
				{ name: "scout", task: "recon" },
				{ name: "planner", task: "plan it" },
			],
		);
	});

	it("parses a shared task via the -- delimiter", () => {
		const result = parseAgentArgs("scout reviewer -- audit the diff", "parallel");
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.steps.map((s) => s.name), ["scout", "reviewer"]);
		assert.equal(result.task, "audit the diff");
		assert.equal(result.steps[0]?.task, undefined);
	});

	it("resolves the shared task from the first per-step task across arrow steps", () => {
		const result = parseAgentArgs(`scout -> planner "do it"`, "parallel");
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.task, "do it");
		assert.equal(result.steps[0]?.task, undefined);
		assert.equal(result.steps[1]?.task, "do it");
	});

	it("parses bracket config on a step that also has a task", () => {
		const result = parseAgentArgs(`reviewer[output=notes.md,progress] "audit" -> planner "next"`, "chain");
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.steps.length, 2);
		assert.equal(result.steps[0]?.name, "reviewer");
		assert.equal(result.steps[0]?.task, "audit");
		assert.deepEqual(result.steps[0]?.config, { output: "notes.md", progress: true });
	});

	it("returns a usage error on empty input", () => {
		const result = parseAgentArgs("", "chain");
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.error.code, "usage");
		assert.equal(result.error.message, `Usage: /chain agent1 "task1" -> agent2 "task2"`);
	});

	it("uses the command name in the usage error", () => {
		const result = parseAgentArgs("", "parallel");
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.error.message, `Usage: /parallel agent1 "task1" -> agent2 "task2"`);
	});

	it("returns a chain-first-task error when the first step has no task", () => {
		const result = parseAgentArgs("scout -> planner", "chain");
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.error.code, "chain-first-task");
		assert.equal(result.error.message, `First step must have a task: /chain agent "task" -> agent2`);
	});

	it("returns a parallel-task error when no step has a task", () => {
		const result = parseAgentArgs("scout -> reviewer", "parallel");
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.error.code, "parallel-task");
		assert.equal(result.error.message, "At least one step must have a task");
	});
});
