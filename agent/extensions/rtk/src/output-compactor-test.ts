import assert from "node:assert/strict";
import { join } from "node:path";
// @ts-expect-error Bun provides bun:test at runtime, but this package does not ship Bun types.
import { mock } from "bun:test";

import { cloneDefaultConfig, runTest } from "./test-helpers.ts";

const TEST_AGENT_DIR = "/tmp/.pi/agent";

mock.module("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => TEST_AGENT_DIR,
}));

const { compactToolResult } = await import("./output-compactor.ts");

function sourceLineFor(lineNumber: number): string {
	return lineNumber % 2 === 0 ? `const value${lineNumber} = ${lineNumber};` : `// comment ${lineNumber}`;
}

function buildReadContent(lineCount: number): string {
	return `${Array.from({ length: lineCount }, (_value, index) => sourceLineFor(index)).join("\n")}\n`;
}

function buildAnchoredReadContent(formatLine: (lineNumber: number, sourceLine: string) => string): string {
	return Array.from({ length: 120 }, (_value, index) => {
		const lineNumber = index + 1;
		return formatLine(lineNumber, sourceLineFor(lineNumber));
	}).join("\n");
}

function setReadCompaction(config: ReturnType<typeof cloneDefaultConfig>, enabled: boolean): void {
	config.outputCompaction.readCompaction = { enabled };
}

function firstTextBlock(content: unknown[] | undefined): string {
	if (!Array.isArray(content) || content.length === 0) {
		return "";
	}
	const first = content[0] as { type?: string; text?: string };
	if (first?.type !== "text" || typeof first.text !== "string") {
		return "";
	}
	return first.text;
}

function compactReadContent(
	config: ReturnType<typeof cloneDefaultConfig>,
	content: string,
	input: Record<string, unknown> = { path: "sample.ts" },
) {
	return compactToolResult({ toolName: "read", input, content: [{ type: "text", text: content }] }, config);
}

function assertChangedWithTechnique(result: ReturnType<typeof compactToolResult>, technique: string): string {
	assert.equal(result.changed, true);
	assert.ok(result.techniques.includes(technique));
	return firstTextBlock(result.content);
}

function compactSourceRead(config: ReturnType<typeof cloneDefaultConfig>, content: string): string {
	return assertChangedWithTechnique(compactReadContent(config, content), "source:minimal");
}

function enableMinimalReadCompaction(config: ReturnType<typeof cloneDefaultConfig>): void {
	setReadCompaction(config, true);
	config.outputCompaction.sourceCodeFilteringEnabled = true;
	config.outputCompaction.sourceCodeFiltering = "minimal";
	config.outputCompaction.smartTruncate.enabled = true;
	config.outputCompaction.smartTruncate.maxLines = 40;
}

function enableReadTruncation(config: ReturnType<typeof cloneDefaultConfig>, maxChars: number): void {
	config.outputCompaction.truncate.enabled = true;
	config.outputCompaction.truncate.maxChars = maxChars;
}

function enableExactReadSafeguards(config: ReturnType<typeof cloneDefaultConfig>, maxChars = 500): void {
	setReadCompaction(config, true);
	enableReadTruncation(config, maxChars);
	config.outputCompaction.smartTruncate.enabled = true;
	config.outputCompaction.smartTruncate.maxLines = 40;
}

function assertUnchangedRead(
	config: ReturnType<typeof cloneDefaultConfig>,
	content: string,
	input: Record<string, unknown> = { path: "sample.ts" },
): void {
	const result = compactReadContent(config, content, input);
	assert.equal(result.changed, false);
	assert.deepEqual(result.techniques, []);
}

const OUTPUT_EMOJI_MARKERS = ["✓", "✔", "❌", "⚠️", "⚠", "📋", "📄", "🔍", "✅", "⏭️", "📌", "📝", "❓", "•"];

function compactBashResult(command: string, text: string) {
	return compactToolResult({ toolName: "bash", input: { command }, content: [{ type: "text", text }] }, cloneDefaultConfig());
}

function compactBashOutput(command: string, text: string): string {
	const result = compactBashResult(command, text);
	assert.equal(result.changed, true);
	return firstTextBlock(result.content);
}

function assertUnchangedBashOutput(command: string, text: string): void {
	const result = compactBashResult(command, text);
	assert.equal(result.changed, false);
	assert.equal(result.content, undefined);
	assert.deepEqual(result.techniques, []);
}

function compactGrepOutput(text: string): string {
	const result = compactToolResult(
		{
			toolName: "grep",
			input: { pattern: "match" },
			content: [{ type: "text", text }],
		},
		cloneDefaultConfig(),
	);

	assert.equal(result.changed, true);
	return firstTextBlock(result.content);
}

function assertNoOutputEmoji(text: string): void {
	for (const marker of OUTPUT_EMOJI_MARKERS) {
		assert.equal(text.includes(marker), false, `Unexpected output emoji marker: ${marker}`);
	}
}

function assertNoPartialHashlineAnchors(text: string): void {
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*\d+\s*#[A-Za-z0-9_-]{2,32}:/.test(line)) {
			assert.equal(line.endsWith("..."), false, `Anchor line was partially truncated: ${line}`);
		}
	}
}

runTest("precision read with offset keeps exact output (no source/smart/hard truncation)", () => {
	const config = cloneDefaultConfig();
	enableExactReadSafeguards(config);

	const content = buildReadContent(220);
	assertUnchangedRead(config, content, { path: "sample.ts", offset: 1 });
});

runTest("precision read with limit keeps exact output", () => {
	const config = cloneDefaultConfig();
	enableExactReadSafeguards(config);

	const content = buildReadContent(220);
	assertUnchangedRead(config, content, { path: "sample.ts", limit: 200 });
});

runTest("default read output stays exact when read compaction is disabled by default", () => {
	const config = cloneDefaultConfig();
	config.outputCompaction.sourceCodeFilteringEnabled = true;
	config.outputCompaction.sourceCodeFiltering = "aggressive";
	config.outputCompaction.smartTruncate.enabled = true;
	config.outputCompaction.smartTruncate.maxLines = 40;
	config.outputCompaction.truncate.enabled = true;
	config.outputCompaction.truncate.maxChars = 500;

	const content = buildReadContent(220);
	assertUnchangedRead(config, content);
});

runTest("normal read compacts and adds banner when read compaction is enabled", () => {
	const config = cloneDefaultConfig();
	enableMinimalReadCompaction(config);

	const compacted = compactSourceRead(config, buildReadContent(220));
	assert.ok(compacted.startsWith("[RTK compacted output:"));
	assert.ok(compacted.includes("source:minimal"));
});

runTest("line-anchor read output compacts without corrupting LINE#HASH anchors", () => {
	const config = cloneDefaultConfig();
	enableMinimalReadCompaction(config);
	enableReadTruncation(config, 5000);

	const content = buildAnchoredReadContent((lineNumber, sourceLine) => `${String(lineNumber).padStart(3, " ")}#ZP:${sourceLine}`);
	const compacted = compactSourceRead(config, content);
	assert.ok(compacted.startsWith("[RTK compacted output:"));
	assert.ok(compacted.includes("source:minimal"));
	assert.match(compacted, /\n\s*2#ZP:const value2 = 2;/);
	assert.equal(compacted.includes("#ZP:// comment"), false);
	assertNoPartialHashlineAnchors(compacted);
});

runTest("colon-pipe anchor read output compacts without requiring hashline extension", () => {
	const config = cloneDefaultConfig();
	enableMinimalReadCompaction(config);
	enableReadTruncation(config, 5000);

	const content = [
		"Read sample.ts: 120 lines",
		"",
		buildAnchoredReadContent(
			(lineNumber, sourceLine) => `${lineNumber}:${(lineNumber % 256).toString(16).padStart(2, "0")}|${sourceLine}`,
		),
	].join("\n");
	const compacted = compactSourceRead(config, content);
	assert.ok(compacted.includes("Read sample.ts: 120 lines"));
	assert.match(compacted, /\n2:02\|const value2 = 2;/);
	assert.equal(compacted.includes("|// comment"), false);
});

runTest("compact LINEHASH pipe anchors from oh-my-pi style reads", () => {
	const config = cloneDefaultConfig();
	enableMinimalReadCompaction(config);
	enableReadTruncation(config, 5000);

	const content = buildAnchoredReadContent((lineNumber, sourceLine) => {
		const hash = lineNumber % 2 === 0 ? "sr" : "ab";
		return `${lineNumber}${hash}|${sourceLine}`;
	});
	const compacted = compactSourceRead(config, content);
	assert.match(compacted, /\n2sr\|const value2 = 2;/);
	assert.equal(compacted.includes("|// comment"), false);
});

runTest("compact hashline-tools file wrapper while preserving non-anchor wrapper lines", () => {
	const config = cloneDefaultConfig();
	enableMinimalReadCompaction(config);
	enableReadTruncation(config, 5000);

	const content = [
		"<file>",
		buildAnchoredReadContent((lineNumber, sourceLine) => `${lineNumber}#ZM:${sourceLine}`),
		"",
		"(End of file - 120 total lines)",
		"</file>",
	].join("\n");
	const compacted = compactSourceRead(config, content);
	assert.ok(compacted.includes("<file>"));
	assert.ok(compacted.includes("(End of file - 120 total lines)"));
	assert.ok(compacted.includes("</file>"));
	assert.match(compacted, /\n2#ZM:const value2 = 2;/);
	assert.equal(compacted.includes("#ZM:// comment"), false);
});

runTest("anchor-safe read hard truncation preserves whole hashline anchors", () => {
	const config = cloneDefaultConfig();
	setReadCompaction(config, true);
	config.outputCompaction.sourceCodeFilteringEnabled = false;
	config.outputCompaction.smartTruncate.enabled = false;
	config.outputCompaction.truncate.enabled = true;
	config.outputCompaction.truncate.maxChars = 350;

	const content = Array.from({ length: 120 }, (_value, index) => {
		const lineNumber = index + 1;
		return `${lineNumber}#ZP:const value${lineNumber} = "${"x".repeat(40)}";`;
	}).join("\n");
	const result = compactReadContent(config, content);

	assert.equal(result.changed, true);
	assert.ok(result.techniques.includes("truncate"));

	const compacted = firstTextBlock(result.content);
	assert.ok(compacted.includes("anchor-safe truncate"));
	assertNoPartialHashlineAnchors(compacted);
});

runTest("incidental single anchor-like line does not disable normal read compaction", () => {
	const config = cloneDefaultConfig();
	enableMinimalReadCompaction(config);

	const content = [`1#ZP:not an anchored read`, buildReadContent(120)].join("\n");
	const result = compactReadContent(config, content);
	assert.equal(result.changed, true);
	assert.ok(result.techniques.includes("source:minimal") || result.techniques.includes("smart-truncate"));
});

runTest("short read output stays exact below threshold", () => {
	const config = cloneDefaultConfig();
	setReadCompaction(config, true);
	const content = buildReadContent(40);

	assertUnchangedRead(config, content);
});

runTest("read output stays exact at the 80-line boundary with trailing newline", () => {
	const config = cloneDefaultConfig();
	setReadCompaction(config, true);
	config.outputCompaction.smartTruncate.enabled = true;
	config.outputCompaction.smartTruncate.maxLines = 40;

	const content = buildReadContent(80);
	assertUnchangedRead(config, content);
});

runTest("read output compacts once the content exceeds the 80-line exactness threshold when read compaction is enabled", () => {
	const config = cloneDefaultConfig();
	enableMinimalReadCompaction(config);

	const result = compactReadContent(config, buildReadContent(81));
	assert.equal(result.changed, true);
	assert.ok(result.techniques.includes("source:minimal") || result.techniques.includes("smart-truncate"));
});

runTest("source file reads skip lossy source filtering when truncation safeguards are not needed", () => {
	const config = cloneDefaultConfig();
	setReadCompaction(config, true);
	config.outputCompaction.sourceCodeFilteringEnabled = true;
	config.outputCompaction.sourceCodeFiltering = "minimal";
	config.outputCompaction.smartTruncate.enabled = false;
	config.outputCompaction.truncate.enabled = false;

	const content = buildReadContent(120);
	const result = compactReadContent(config, content);

	assert.equal(result.changed, false);
	assert.deepEqual(result.techniques, []);
	assert.equal(firstTextBlock(result.content), "");
});

runTest("skill reads stay exact when preserveExactSkillReads is enabled for user skills", () => {
	const config = cloneDefaultConfig();
	enableExactReadSafeguards(config);
	config.outputCompaction.preserveExactSkillReads = true;

	const content = buildReadContent(220);
	assertUnchangedRead(config, content, { path: join(TEST_AGENT_DIR, "skills", "example", "SKILL.md") });
});

runTest("project .pi skill reads stay exact when preserveExactSkillReads is enabled", () => {
	const config = cloneDefaultConfig();
	enableExactReadSafeguards(config);
	config.outputCompaction.preserveExactSkillReads = true;

	const content = buildReadContent(220);
	assertUnchangedRead(config, content, { path: ".pi/skills/example/SKILL.md" });
});

runTest("ancestor .agents skill reads stay exact when preserveExactSkillReads is enabled", () => {
	const config = cloneDefaultConfig();
	enableExactReadSafeguards(config);
	config.outputCompaction.preserveExactSkillReads = true;

	const content = buildReadContent(220);
	assertUnchangedRead(config, content, { path: "../.agents/skills/example/SKILL.md" });
});

runTest("build output uses plain-text status markers", () => {
	const compacted = compactBashOutput("npm run build", "Compiling app v0.1.0\n");

	assert.equal(compacted, "[OK] Build successful (1 units compiled)");
	assertNoOutputEmoji(compacted);
});

runTest("build output summarizes warnings and error blocks", () => {
	assert.equal(compactBashOutput("npm run build", "warning: unused import\n"), "\n[WARN] 1 warning(s)");

	assert.equal(
		compactBashOutput(
			"npm run build",
			"error: failed to compile\n  --> src/main.rs:1:1\n   |\n1 | nope\n\n\nnext line\n",
		),
		"[ERROR] 1 error(s):\nerror: failed to compile\n  --> src/main.rs:1:1\n   |",
	);
});

runTest("git status output uses plain-text labels", () => {
	const compacted = compactBashOutput(
		"git status --short --branch",
		"## main...origin/main\nM  staged.ts\n M modified.ts\n?? new.ts\nUU conflict.ts\n",
	);

	assert.ok(compacted.startsWith("Branch: main\n"));
	assert.ok(compacted.includes("Staged: 1 files\n  staged.ts\n"));
	assert.ok(compacted.includes("Modified: 1 files\n  modified.ts\n"));
	assert.ok(compacted.includes("Untracked: 1 files\n  new.ts\n"));
	assert.ok(compacted.includes("Conflicts: 1 files"));
	assertNoOutputEmoji(compacted);
});

runTest("git diff output uses plain-text file markers", () => {
	const compacted = compactBashOutput(
		"git diff",
		"diff --git a/src/example.ts b/src/example.ts\n@@ -1 +1 @@\n-oldValue\n+newValue\n",
	);

	assert.ok(compacted.includes("\n> src/example.ts\n"));
	assertNoOutputEmoji(compacted);
});

runTest("linter success output uses plain-text status markers", () => {
	const compacted = compactBashOutput("npx eslint .", "");

	assert.equal(compacted, "[OK] ESLint: No issues found");
	assertNoOutputEmoji(compacted);
});

runTest("test output uses plain-text labels and bullets", () => {
	const compacted = compactBashOutput(
		"bun test",
		"3 passed, 1 failed, 2 skipped\nFAIL src/example.test.ts\n  Expected: true\n  Received: false\n\n\n",
	);

	assert.ok(compacted.includes("Test Results:"));
	assert.ok(compacted.includes("PASS: 3 passed"));
	assert.ok(compacted.includes("FAIL: 1 failed"));
	assert.ok(compacted.includes("SKIP: 2 skipped"));
	assert.ok(compacted.includes("   - FAIL src/example.test.ts"));
	assertNoOutputEmoji(compacted);
});

runTest("search output uses plain-text summary and file markers", () => {
	const compacted = compactGrepOutput("src/a.ts:1:const match = true;\nsrc/b.ts:2:return match;\n");

	assert.ok(compacted.startsWith("2 matches in 2 files:\n\n"));
	assert.ok(compacted.includes("> src/a.ts (1 matches):\n"));
	assert.ok(compacted.includes("> src/b.ts (1 matches):\n"));
	assertNoOutputEmoji(compacted);
});

runTest("rtk env output sanitizes emoji section headers", () => {
	const compacted = compactBashOutput(
		"rtk env",
		"📂 PATH Variables:\n🔧 Language/Runtime:\n☁️  Cloud/Services:\n🛠️  Tools:\n📋 Other:\n📊 Total: 91 vars\n",
	);

	assert.ok(compacted.includes("PATH Variables:"));
	assert.ok(compacted.includes("Language/Runtime:"));
	assert.ok(compacted.includes("Cloud/Services:"));
	assert.ok(compacted.includes("Tools:"));
	assert.ok(compacted.includes("Other:"));
	assert.ok(compacted.includes("Total: 91 vars"));
	assertNoOutputEmoji(compacted);
});

runTest("rtk-shaped env output sanitizes even when command name is not rtk", () => {
	const compacted = compactBashOutput(
		"echo probe",
		"📂 PATH Variables:\n🔧 Language/Runtime:\n📊 Total: 91 vars\n",
	);

	assert.ok(compacted.includes("PATH Variables:"));
	assert.ok(compacted.includes("Language/Runtime:"));
	assert.ok(compacted.includes("Total: 91 vars"));
	assertNoOutputEmoji(compacted);
});

runTest("rtk git-style output sanitizes emoji status markers", () => {
	const compacted = compactBashOutput(
		"rtk git status",
		"📌 main\n✅ Staged: 1 files\n📝 Modified: 2 files\n❓ Untracked: 1 files\n⚠️  Conflicts: 1 files\n",
	);

	assert.ok(compacted.includes("Branch: main"));
	assert.ok(compacted.includes("[OK] Staged: 1 files"));
	assert.ok(compacted.includes("Modified: 2 files"));
	assert.ok(compacted.includes("[INFO] Untracked: 1 files"));
	assert.ok(compacted.includes("[WARN]  Conflicts: 1 files"));
	assertNoOutputEmoji(compacted);
});

runTest("rtk grep-style output sanitizes emoji file markers", () => {
	const compacted = compactBashOutput(
		"rtk grep EXTENSION_NAME agent/extensions/rtksrc/constants.ts",
		"🔍 2 in 1F:\n\n📄 agent/extensions/rtksrc/constants.ts (2):\n     4: export const EXTENSION_NAME = \"pi-rtk-optimizer\";\n",
	);

	assert.ok(compacted.startsWith("2 in 1F:\n\n> agent/extensions/rtksrc/constants.ts (2):"));
	assertNoOutputEmoji(compacted);
});

runTest("rtk git diff verbose summary sanitizes file markers", () => {
	const compacted = compactBashOutput(
		"rtk git diff -- agent/extensions/pi-mcp-adapter/package.json",
		"agent/extensions/pi-mcp-adapter/package.json | 2 +-\n\n--- Changes ---\n\n📄 agent/extensions/pi-mcp-adapter/package.json\n  @@ -38,7 +38,7 @@\n  -    \"@earendil-works/pi-coding-agent\": \"^0.58.1\",\n",
	);

	assert.ok(compacted.includes("--- Changes ---"));
	assert.ok(compacted.includes("> agent/extensions/pi-mcp-adapter/package.json"));
	assertNoOutputEmoji(compacted);
});

runTest("git diff compaction skips already-compacted RTK-shaped output", () => {
	const compacted = compactBashOutput(
		"git diff -- agent/extensions/pi-mcp-adapter/package.json",
		"agent/extensions/pi-mcp-adapter/package.json | 2 +-\n\n--- Changes ---\n\n📄 agent/extensions/pi-mcp-adapter/package.json\n  @@ -38,7 +38,7 @@\n  -    \"@earendil-works/pi-coding-agent\": \"^0.58.1\",\n",
	);

	assert.ok(compacted.includes("--- Changes ---"));
	assert.ok(compacted.includes("> agent/extensions/pi-mcp-adapter/package.json"));
	assertNoOutputEmoji(compacted);
});

runTest("rtk-shaped diff output sanitizes even when command name is not rtk", () => {
	const compacted = compactBashOutput(
		"echo probe",
		"📊 file-a.txt → file-b.txt\n   +1 added, -1 removed, ~0 modified\n\n-   2 beta\n+   2 gamma\n",
	);

	assert.ok(compacted.startsWith("file-a.txt -> file-b.txt"));
	assertNoOutputEmoji(compacted);
});

runTest("rtk-shaped identical diff output sanitizes even when command name is not rtk", () => {
	const compacted = compactBashOutput("echo probe", "✅ Files are identical");

	assert.equal(compacted, "[OK] Files are identical");
	assertNoOutputEmoji(compacted);
});

runTest("hook warning is stripped even when the command label is not rtk", () => {
	const compacted = compactBashOutput(
		"echo probe",
		"[rtk] /!\\ No hook installed — run `rtk init -g` for automatic token savings\n\n4 files changed\n",
	);

	assert.equal(compacted, "4 files changed\n");
});

runTest("hook-only output compacts to an empty text result", () => {
	const result = compactToolResult(
		{
			toolName: "bash",
			input: { command: "rtk git status" },
			content: [{ type: "text", text: "[rtk] /!\\ No hook installed — run `rtk init -g` for automatic token savings\n" }],
		},
		cloneDefaultConfig(),
	);

	assert.equal(result.changed, true);
	assert.ok(result.techniques.includes("rtk-hook-warning"));
	assert.equal(firstTextBlock(result.content), "");
});

runTest("non-hook RTK warnings are preserved verbatim", () => {
	assertUnchangedBashOutput("FOO=1 rtk git status", "[rtk] warning: builtin filters: parse failure\n\nworking tree clean\n");
});

runTest("emoji RTK warnings stay visible and are sanitized to plain text", () => {
	const compacted = compactBashOutput(
		"rtk init --hook-only",
		"⚠️  Warning: --hook-only only makes sense with --global\n    For local projects, use default mode or --claude-md\n\nready\n",
	);

	assert.ok(compacted.includes("[WARN]  Warning: --hook-only only makes sense with --global"));
	assert.ok(compacted.includes("For local projects, use default mode or --claude-md"));
	assert.ok(compacted.includes("ready\n"));
	assertNoOutputEmoji(compacted);
});

runTest("outdated hook warning is stripped while preserving the RTK payload", () => {
	const compacted = compactBashOutput(
		"rtk gain",
		"⚠️  Hook outdated — run `rtk init -g` to update\n\nSaved 42 tokens\n",
	);

	assert.equal(compacted, "Saved 42 tokens\n");
});

runTest("quoted hook warning text is preserved as payload", () => {
	const quotedHookText = 'const warning = "No hook installed — run `rtk init -g` for automatic token savings";\n';
	assertUnchangedBashOutput("echo probe", quotedHookText);
});

console.log("All output-compactor tests passed.");
