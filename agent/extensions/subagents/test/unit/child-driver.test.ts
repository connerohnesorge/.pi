import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createMockPi, type MockPi } from "../support/mock-pi.ts";
import {
	accumulateAssistantUsage,
	driveChildProcess,
	type ChildEvent,
} from "../../src/runs/shared/child-driver.ts";
import type { Usage } from "../../src/shared/types.ts";

const JSON_ARGS = ["--mode", "json", "-p"];

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function assistantStop(text: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}): object {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "mock/test-model",
			stopReason: "stop",
			usage,
			...extra,
		},
	};
}

describe("driveChildProcess", () => {
	let cwd: string;
	let mockPi: MockPi;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
	});

	after(() => {
		mockPi.uninstall();
	});

	beforeEach(() => {
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-driver-"));
		mockPi.reset();
	});

	it("parses the event stream into messages, usage, and model", async () => {
		mockPi.onCall({
			jsonl: [
				{ type: "tool_execution_start", toolName: "read", args: { path: "a.txt" } },
				{ type: "tool_result_end", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file body" }] } },
				assistantStop("all done", { input: 100, output: 50, cacheRead: 1, cacheWrite: 2, cost: { total: 0.001 } }),
			],
		});

		const seen: ChildEvent[] = [];
		const result = await driveChildProcess({
			args: JSON_ARGS,
			cwd,
			onEvent: (event) => seen.push(event),
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
		assert.equal(result.model, "mock/test-model");
		// message_end + tool_result_end are accumulated as messages (tool_execution_start is not).
		assert.equal(result.messages.length, 2);
		assert.equal(result.usage.turns, 1);
		assert.equal(result.usage.input, 100);
		assert.equal(result.usage.output, 50);
		assert.equal(result.usage.cacheRead, 1);
		assert.equal(result.usage.cacheWrite, 2);
		assert.ok(Math.abs(result.usage.cost - 0.001) < 1e-9);
		assert.equal(result.finalOutput, "all done");
		// The projection seam observes every parsed event in order.
		assert.deepEqual(seen.map((e) => e.type), ["tool_execution_start", "tool_result_end", "message_end"]);
	});

	it("surfaces non-JSON stdout through onRawStdoutLine and keeps it out of messages", async () => {
		mockPi.onCall({
			steps: [
				{ jsonl: ["not json at all", assistantStop("done", { input: 5, output: 7 })] },
			],
		});

		const rawLines: string[] = [];
		const result = await driveChildProcess({
			args: JSON_ARGS,
			cwd,
			onRawStdoutLine: (line) => rawLines.push(line),
		});

		assert.equal(result.exitCode, 0);
		assert.deepEqual(rawLines, ["not json at all"]);
		assert.deepEqual(result.rawStdout, ["not json at all"]);
		assert.equal(result.messages.length, 1);
	});

	it("accounts both token-field spellings identically", async () => {
		mockPi.onCall({ jsonl: [assistantStop("canonical", { input: 120, output: 34 })] });
		const canonical = await driveChildProcess({ args: JSON_ARGS, cwd });

		mockPi.onCall({ jsonl: [assistantStop("alternate", { inputTokens: 120, outputTokens: 34 })] });
		const alternate = await driveChildProcess({ args: JSON_ARGS, cwd });

		assert.equal(canonical.usage.input, alternate.usage.input);
		assert.equal(canonical.usage.output, alternate.usage.output);
		assert.equal(alternate.usage.input, 120);
		assert.equal(alternate.usage.output, 34);
	});

	it("accumulateAssistantUsage treats both spellings the same", () => {
		const canonical = emptyUsage();
		accumulateAssistantUsage(canonical, { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } });
		const alternate = emptyUsage();
		accumulateAssistantUsage(alternate, { inputTokens: 10, outputTokens: 20, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } });
		assert.deepEqual(canonical, alternate);
		assert.equal(canonical.input, 10);
		assert.equal(canonical.output, 20);
	});

	it("reports a clean forced-drain-after-final-success as exit code 0", async () => {
		// Clean terminal assistant stop, then the child refuses to exit. The driver
		// must escalate (SIGTERM) and still report the run as a clean success (exit 0).
		mockPi.onCall({
			jsonl: [assistantStop("final answer", { input: 10, output: 5 })],
			keepAliveAfterFinalMessageMs: 5000,
		});

		const start = Date.now();
		const result = await driveChildProcess({ args: JSON_ARGS, cwd });
		const elapsed = Date.now() - start;

		assert.equal(result.forcedTermination, true, "expected the drain to deliver a termination signal");
		assert.equal(result.cleanTerminalStop, true);
		assert.equal(result.exitCode, 0, "clean final success drained by force is exit 0");
		assert.equal(result.error, undefined);
		assert.equal(result.finalOutput, "final answer");
		// The grace window is ~1s; the child should be cut off well before its 5s keep-alive.
		assert.ok(elapsed >= 1000, `expected at least the grace window, got ${elapsed}ms`);
		assert.ok(elapsed < 4000, `expected forced drain before keep-alive elapsed, got ${elapsed}ms`);
	});

	it("records the forced-termination message when the final stop carried an error", async () => {
		// A non-clean terminal stop (assistant errorMessage) that then hangs: the driver
		// forces termination and reports the did-not-exit message rather than success.
		mockPi.onCall({
			jsonl: [assistantStop("partial", { input: 1, output: 1 }, { errorMessage: "boom" })],
			keepAliveAfterFinalMessageMs: 5000,
		});

		const result = await driveChildProcess({ args: JSON_ARGS, cwd });

		assert.equal(result.forcedTermination, true);
		assert.equal(result.cleanTerminalStop, false);
		assert.notEqual(result.exitCode, 0);
		assert.equal(result.error, "boom");
	});

	it("passes the subagent depth env down to the child", async () => {
		mockPi.onCall({ echoEnv: ["PI_SUBAGENT_DEPTH"] });
		const result = await driveChildProcess({ args: JSON_ARGS, cwd });
		const snapshot = JSON.parse(result.finalOutput) as { PI_SUBAGENT_DEPTH?: string };
		assert.equal(snapshot.PI_SUBAGENT_DEPTH, "1");
	});

	it("resolves early and leaves the child running when detached", async () => {
		// The detach trigger resolves the driver without killing; the child keeps running.
		mockPi.onCall({
			steps: [
				{ jsonl: [{ type: "tool_execution_start", toolName: "intercom", args: { action: "ask" } }] },
				{ delay: 1500, jsonl: [assistantStop("late", { input: 1, output: 1 })] },
			],
		});

		let detach: (() => void) | undefined;
		const start = Date.now();
		const result = await driveChildProcess({
			args: JSON_ARGS,
			cwd,
			registerDetach: (trigger) => {
				detach = trigger;
			},
			onEvent: (event) => {
				if (event.type === "tool_execution_start" && event.toolName === "intercom") detach?.();
			},
		});
		const elapsed = Date.now() - start;

		assert.equal(result.detached, true);
		assert.equal(result.exitCode, null, "detach observed no process exit");
		// Resolved on the detach trigger, not after the child's 1.5s tail.
		assert.ok(elapsed < 1200, `expected early detach resolve, got ${elapsed}ms`);
	});
});
