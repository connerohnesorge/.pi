import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_FIELDS, KNOWN_FIELDS, joinToolList, splitToolList } from "../../src/agents/agent-fields.ts";

describe("AGENT_FIELDS / KNOWN_FIELDS", () => {
	it("derives KNOWN_FIELDS as the union of every frontmatter key in the table", () => {
		const expected = new Set(AGENT_FIELDS.flatMap((field) => field.frontmatterKeys));
		assert.equal(KNOWN_FIELDS.size, expected.size);
		for (const key of expected) assert.ok(KNOWN_FIELDS.has(key), `KNOWN_FIELDS should contain '${key}'`);
		for (const key of KNOWN_FIELDS) assert.ok(expected.has(key), `KNOWN_FIELDS should not contain extra '${key}'`);
	});

	it("includes the documented frontmatter keys (incl. the skill/skills alias)", () => {
		for (const key of [
			"name", "package", "description", "tools", "model", "fallbackModels", "thinking",
			"systemPromptMode", "inheritProjectContext", "inheritSkills", "defaultContext",
			"skill", "skills", "extensions", "output", "defaultReads", "defaultProgress",
			"interactive", "maxSubagentDepth", "completionGuard",
		]) {
			assert.ok(KNOWN_FIELDS.has(key), `expected '${key}' to be a known field`);
		}
	});

	it("defines the skill/skills alias once, mapped to the skills config field", () => {
		const skillRows = AGENT_FIELDS.filter((field) => field.frontmatterKeys.includes("skill") || field.frontmatterKeys.includes("skills"));
		assert.equal(skillRows.length, 1, "skill/skills alias should live in exactly one descriptor");
		assert.equal(skillRows[0].config, "skills");
		assert.deepEqual(skillRows[0].frontmatterKeys, ["skill", "skills"]);
	});

	it("gives every frontmatter key exactly one descriptor", () => {
		const seen = new Map<string, number>();
		for (const field of AGENT_FIELDS) {
			for (const key of field.frontmatterKeys) seen.set(key, (seen.get(key) ?? 0) + 1);
		}
		for (const [key, count] of seen) assert.equal(count, 1, `frontmatter key '${key}' should map to exactly one descriptor`);
	});
});

describe("splitToolList", () => {
	it("separates plain tools from mcp:-prefixed direct tools", () => {
		const split = splitToolList(["read", "grep", "mcp:server/tool", "bash", "mcp:other/x"]);
		assert.deepEqual(split, {
			tools: ["read", "grep", "bash"],
			mcpDirectTools: ["server/tool", "other/x"],
		});
	});

	it("omits empty groups", () => {
		assert.deepEqual(splitToolList(["mcp:a/b"]), { mcpDirectTools: ["a/b"] });
		assert.deepEqual(splitToolList(["read"]), { tools: ["read"] });
		assert.deepEqual(splitToolList([]), {});
		assert.deepEqual(splitToolList(undefined), {});
	});

	it("trims the direct name and drops empty mcp: entries", () => {
		assert.deepEqual(splitToolList(["mcp:  spaced  ", "mcp:", "plain"]), {
			tools: ["plain"],
			mcpDirectTools: ["spaced"],
		});
	});
});

describe("joinToolList", () => {
	it("is the inverse of splitToolList: plain tools then mcp:-prefixed", () => {
		const original = ["read", "grep", "bash", "mcp:server/tool", "mcp:other/x"];
		const split = splitToolList(original);
		assert.deepEqual(joinToolList(split), original);
	});

	it("returns undefined when there are no tools", () => {
		assert.equal(joinToolList({}), undefined);
		assert.equal(joinToolList({ tools: undefined, mcpDirectTools: undefined }), undefined);
	});

	it("emits only plain or only mcp: when one side is empty", () => {
		assert.deepEqual(joinToolList({ tools: ["read"] }), ["read"]);
		assert.deepEqual(joinToolList({ mcpDirectTools: ["a/b"] }), ["mcp:a/b"]);
	});
});
