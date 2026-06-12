import test from "node:test";
import assert from "node:assert/strict";
import {
	buildPromptHistory,
	extractPromptTextFromMessageContent,
	extractPromptsFromEntries,
	extractPromptsFromSessionJsonl,
	filterPromptHistory,
	formatPromptPreview,
	normalizePromptText,
	normalizeSearchText,
} from "../prompt-history.ts";

const source = {
	source: "saved" as const,
	sessionPath: "/tmp/session.jsonl",
	cwd: "/work/project",
	sessionName: "Project chat",
	modifiedMs: Date.parse("2026-06-11T12:00:00.000Z"),
};

test("normalizes prompt text and search keys", () => {
	assert.equal(normalizePromptText("\r\n  hello\r\nworld  "), "hello\nworld");
	assert.equal(normalizeSearchText("  Hello\n\tWorld  "), "hello world");
	assert.equal(formatPromptPreview("one\n  two\tthree", 20), "one two three");
	assert.equal(formatPromptPreview("abcdefghijklmnopqrstuvwxyz", 8), "abcdefg…");
});

test("extracts text from string and text-block user message content", () => {
	assert.equal(extractPromptTextFromMessageContent("  do a thing  "), "do a thing");
	assert.equal(
		extractPromptTextFromMessageContent([
			{ type: "image", source: "ignored" },
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		]),
		"first\nsecond",
	);
	assert.equal(extractPromptTextFromMessageContent([{ type: "image", source: "ignored" }]), null);
});

test("extractPromptsFromEntries keeps only text user prompts", () => {
	const prompts = extractPromptsFromEntries(
		[
			{
				type: "message",
				id: "u1",
				timestamp: "2026-06-11T12:00:01.000Z",
				message: { role: "user", content: "First prompt" },
			},
			{
				type: "message",
				id: "a1",
				message: { role: "assistant", content: [{ type: "text", text: "not a prompt" }] },
			},
			{
				type: "message",
				id: "u2",
				message: { role: "user", content: [{ type: "image", source: "ignored" }] },
			},
		],
		{ ...source, source: "current" },
	);

	assert.equal(prompts.length, 1);
	assert.equal(prompts[0]?.text, "First prompt");
	assert.equal(prompts[0]?.source, "current");
});

test("extractPromptsFromSessionJsonl ignores malformed lines and non-prompt entries", () => {
	const jsonl = [
		JSON.stringify({ type: "session", version: 3, id: "s1" }),
		"{not json}",
		JSON.stringify({
			type: "message",
			id: "u1",
			message: { role: "user", content: [{ type: "text", text: "Use history" }], timestamp: 1791710400000 },
		}),
		JSON.stringify({ type: "custom", customType: "state", data: {} }),
	].join("\n");

	const prompts = extractPromptsFromSessionJsonl(jsonl, source);
	assert.equal(prompts.length, 1);
	assert.equal(prompts[0]?.text, "Use history");
	assert.equal(prompts[0]?.timestampMs, 1791710400000);
});

test("buildPromptHistory deduplicates by normalized text and keeps newest first", () => {
	const older = extractPromptsFromEntries(
		[
			{
				type: "message",
				id: "u1",
				message: { role: "user", content: "repeat prompt", timestamp: 1000 },
			},
			{
				type: "message",
				id: "u2",
				message: { role: "user", content: "another prompt", timestamp: 2000 },
			},
		],
		source,
	);
	const newer = extractPromptsFromEntries(
		[
			{
				type: "message",
				id: "u3",
				message: { role: "user", content: "  repeat\n prompt  ", timestamp: 3000 },
			},
		],
		source,
	);

	const history = buildPromptHistory([...older, ...newer]);
	assert.deepEqual(
		history.map((prompt) => prompt.text),
		["repeat\n prompt", "another prompt"],
	);
	assert.equal(history[0]?.entryId, "u3");
});

test("filterPromptHistory matches query tokens across prompt and metadata", () => {
	const history = buildPromptHistory(
		extractPromptsFromEntries(
			[
				{
					type: "message",
					id: "u1",
					message: { role: "user", content: "deploy the billing worker", timestamp: 1000 },
				},
				{
					type: "message",
					id: "u2",
					message: { role: "user", content: "write tests", timestamp: 2000 },
				},
			],
			source,
		),
	);

	assert.deepEqual(
		filterPromptHistory(history, "billing deploy").map((prompt) => prompt.text),
		["deploy the billing worker"],
	);
	assert.deepEqual(
		filterPromptHistory(history, "Project chat").map((prompt) => prompt.text),
		["write tests", "deploy the billing worker"],
	);
});
