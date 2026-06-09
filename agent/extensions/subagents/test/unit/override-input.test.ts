import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeOverrideInput, type OverrideInput } from "../../src/runs/shared/override-input.ts";
import type { StepOverrides } from "../../src/shared/settings.ts";

describe("normalizeOverrideInput", () => {
	describe("output sentinel decode", () => {
		const cases: Array<{
			name: string;
			output: string | boolean | undefined;
			agentDefault?: string;
			expected: string | false | undefined;
		}> = [
			{ name: "boolean true -> agent default", output: true, agentDefault: "default.md", expected: "default.md" },
			{ name: "string \"true\" -> agent default", output: "true", agentDefault: "default.md", expected: "default.md" },
			{ name: "boolean true with no default -> omitted", output: true, agentDefault: undefined, expected: undefined },
			{ name: "boolean false -> false", output: false, agentDefault: "default.md", expected: false },
			{ name: "string \"false\" -> false", output: "false", agentDefault: "default.md", expected: false },
			{ name: "explicit path passes through", output: "reports/out.md", agentDefault: "default.md", expected: "reports/out.md" },
			{ name: "empty string -> omitted", output: "", agentDefault: "default.md", expected: undefined },
			{ name: "undefined -> omitted", output: undefined, agentDefault: "default.md", expected: undefined },
		];

		for (const { name, output, agentDefault, expected } of cases) {
			it(name, () => {
				const result = normalizeOverrideInput({ output }, agentDefault);
				assert.equal(result.output, expected);
				assert.equal("output" in result, expected !== undefined);
			});
		}
	});

	describe("reads decode", () => {
		const cases: Array<{ name: string; reads: string[] | boolean | undefined; expected: string[] | false | undefined }> = [
			{ name: "boolean true defers to default (omitted)", reads: true, expected: undefined },
			{ name: "boolean false disables reads", reads: false, expected: false },
			{ name: "array passes through", reads: ["a.ts", "b.ts"], expected: ["a.ts", "b.ts"] },
			{ name: "undefined omitted", reads: undefined, expected: undefined },
		];

		for (const { name, reads, expected } of cases) {
			it(name, () => {
				const result = normalizeOverrideInput({ reads });
				assert.deepEqual(result.reads, expected);
				assert.equal("reads" in result, expected !== undefined);
			});
		}
	});

	describe("singular skill aliases to plural skills", () => {
		it("string skill becomes a deduped skills array", () => {
			const result = normalizeOverrideInput({ skill: "alpha, beta, alpha" });
			assert.deepEqual(result.skills, ["alpha", "beta"]);
		});

		it("array skill becomes plural skills", () => {
			const result = normalizeOverrideInput({ skill: ["alpha", "beta"] });
			assert.deepEqual(result.skills, ["alpha", "beta"]);
		});

		it("skill: false disables skills", () => {
			const result = normalizeOverrideInput({ skill: false });
			assert.equal(result.skills, false);
		});

		it("skill: true defers to default (omitted)", () => {
			const result = normalizeOverrideInput({ skill: true });
			assert.equal("skills" in result, false);
		});

		it("absent skill omits skills entirely", () => {
			const result = normalizeOverrideInput({});
			assert.equal("skills" in result, false);
			assert.equal("skill" in (result as Record<string, unknown>), false);
		});
	});

	describe("passthrough fields", () => {
		it("forwards outputMode, progress, and model", () => {
			const input: OverrideInput = { outputMode: "file-only", progress: true, model: "openai/gpt-5.4" };
			const result = normalizeOverrideInput(input);
			assert.equal(result.outputMode, "file-only");
			assert.equal(result.progress, true);
			assert.equal(result.model, "openai/gpt-5.4");
		});

		it("omits passthrough fields that are undefined", () => {
			const result = normalizeOverrideInput({});
			assert.equal("outputMode" in result, false);
			assert.equal("progress" in result, false);
			assert.equal("model" in result, false);
		});
	});

	it("decodes a full override input into a resolved StepOverrides", () => {
		const result: StepOverrides = normalizeOverrideInput(
			{ output: true, outputMode: "inline", reads: ["input.md"], progress: true, skill: "alpha+beta", model: "m" },
			"agent-default.md",
		);
		assert.deepEqual(result, {
			output: "agent-default.md",
			outputMode: "inline",
			reads: ["input.md"],
			progress: true,
			skills: ["alpha+beta"],
			model: "m",
		});
	});
});
