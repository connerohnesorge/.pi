// fallow-ignore-file code-duplication
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createResultWatcher } from "../../src/runs/background/result-watcher.ts";
import { createNestedRoute, writeNestedEvent } from "../../src/runs/shared/nested-events.ts";
import { createSubagentState } from "../../src/shared/subagent-state.ts";
import type { SubagentState } from "../../src/shared/types.ts";
import { createRecordingEventBus } from "../support/helpers.ts";

function createState(): SubagentState {
	return createSubagentState({ baseCwd: "/repo" });
}

describe("result watcher", () => {
	it("processes deferred session-scoped results after session identity is restored", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-session-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const pi = {
				events: {
					on: () => () => {},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
					},
				},
			};
			const state = createState();
			const resultPath = path.join(resultsDir, "session-run.json");
			fs.writeFileSync(resultPath, JSON.stringify({
				id: "session-run",
				sessionId: "session-current",
				success: true,
				summary: "done",
			}), "utf-8");

			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
				assert.equal(emitted.length, 0);
				assert.equal(fs.existsSync(resultPath), true);

				state.currentSessionId = "session-current";
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
			assert.equal(fs.existsSync(resultPath), false);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("logs malformed result files instead of swallowing them silently", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			fs.writeFileSync(path.join(resultsDir, "bad.json"), "{bad-json", "utf-8");
			const emitted: unknown[] = [];
			const pi = {
				events: {
					on: () => () => {},
					emit(_event: string, data: unknown) {
						emitted.push(data);
					},
				},
			};
			const state = createState();
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			try {
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.length, 0);
			assert.ok(
				logged.some((entry) => /Failed to process subagent result file/.test(String(entry[0] ?? ""))),
				"expected watcher error to be logged",
			);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("falls back to polling when fs.watch throws EMFILE and preserves grouped intercom delivery", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const events = createRecordingEventBus({ acknowledgeResultIntercom: true });
			const pi = { events };
			const emitted = events.emitted;
			const state = createState();
			state.currentSessionId = "session-1";
			let poll: (() => void) | undefined;
			const emfile = new Error("too many open files") as NodeJS.ErrnoException;
			emfile.code = "EMFILE";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000, {
				fs: {
					...fs,
					watch: () => {
						throw emfile;
					},
				},
				timers: {
					setTimeout,
					clearTimeout() {},
					setInterval(handler: () => void) {
						poll = handler;
						return { unref() {} } as NodeJS.Timeout;
					},
					clearInterval() {
						poll = undefined;
					},
				},
			});
			const originalError = console.error;
			const childSessionPath = path.join(resultsDir, "a-session.jsonl");
			console.error = () => {};
			try {
				watcher.startResultWatcher();
				assert.equal(state.watcher, null);
				assert.notEqual(state.watcherRestartTimer, null);

				fs.writeFileSync(childSessionPath, "", "utf-8");
				fs.writeFileSync(path.join(resultsDir, "async-fallback.json"), JSON.stringify({
					id: "async-fallback",
					runId: "run-fallback",
					agent: "parallel:a+b",
					mode: "parallel",
					success: true,
					state: "complete",
					summary: "Combined summary",
					results: [
						{ agent: "a", output: "Result from a", success: true, sessionFile: childSessionPath, intercomTarget: "subagent-a-run-fallback-1" },
						{ agent: "b", output: "Result from b", success: false, error: "B failed", intercomTarget: "subagent-b-run-fallback-2" },
					],
					sessionId: "session-1",
					intercomTarget: "subagent-chat-main",
				}), "utf-8");
				poll?.();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.some((entry) => entry.event === "subagent:async-complete"), true);
			assert.equal(fs.existsSync(path.join(resultsDir, "async-fallback.json")), false);
			const completion = emitted.find((entry) => entry.event === "subagent:async-complete")?.data as { results?: Array<{ status?: string; summary?: string; sessionPath?: string }> } | undefined;
			assert.equal(completion?.results?.[0]?.sessionPath, childSessionPath);
			assert.equal(completion?.results?.[1]?.status, "failed");
			assert.equal(completion?.results?.[1]?.summary, "B failed\n\nOutput:\nResult from b");
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("falls back to polling when an active fs.watch emits ENOSPC", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-"));
		try {
			const emitted: Array<{ event: string; data: unknown }> = [];
			const pi = {
				events: {
					on: () => () => {},
					emit(event: string, data: unknown) {
						emitted.push({ event, data });
					},
				},
			};
			const state = createState();
			state.currentSessionId = "session-1";
			let poll: (() => void) | undefined;
			let emitWatcherError: ((error: NodeJS.ErrnoException) => void) | undefined;
			const fakeWatcher = {
				on(event: string, handler: (error: NodeJS.ErrnoException) => void) {
					if (event === "error") emitWatcherError = handler;
					return fakeWatcher;
				},
				close() {},
				unref() {},
			} as fs.FSWatcher;
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000, {
				fs: {
					...fs,
					watch: () => fakeWatcher,
				},
				timers: {
					setTimeout,
					clearTimeout() {},
					setInterval(handler: () => void) {
						poll = handler;
						return { unref() {} } as NodeJS.Timeout;
					},
					clearInterval() {
						poll = undefined;
					},
				},
			});
			const originalError = console.error;
			console.error = () => {};
			try {
				watcher.startResultWatcher();
				assert.equal(state.watcher, fakeWatcher);
				const enospc = new Error("inotify limit reached") as NodeJS.ErrnoException;
				enospc.code = "ENOSPC";
				emitWatcherError?.(enospc);
				assert.equal(state.watcher, null);
				assert.notEqual(state.watcherRestartTimer, null);

				fs.writeFileSync(path.join(resultsDir, "done.json"), JSON.stringify({ sessionId: "session-1", summary: "done" }), "utf-8");
				poll?.();
				await new Promise((resolve) => setTimeout(resolve, 75));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(emitted.filter((entry) => entry.event === "subagent:async-complete").length, 1);
			assert.equal(fs.existsSync(path.join(resultsDir, "done.json")), false);
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});



	it("enriches async completion and intercom payloads with nested registry children before deletion", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-nested-"));
		const route = createNestedRoute("async-nested-root");
		try {
			writeNestedEvent(route, {
				type: "subagent.nested.completed",
				ts: Date.now(),
				parentRunId: "async-nested-root",
				parentStepIndex: 0,
				child: {
					id: "nested-child",
					parentRunId: "async-nested-root",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "async-nested-root", stepIndex: 0 }],
					state: "complete",
					agent: "nested-reviewer",
					sessionFile: path.join(resultsDir, "nested-child.jsonl"),
				},
			});
			const events = createRecordingEventBus({ acknowledgeResultIntercom: true });
			const pi = { events };
			const emitted = events.emitted;
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const resultPath = path.join(resultsDir, "async-nested-root.json");
			try {
				fs.writeFileSync(resultPath, JSON.stringify({
					id: "async-nested-root",
					runId: "async-nested-root",
					agent: "owner",
					mode: "single",
					success: true,
					state: "complete",
					summary: "owner done",
					results: [{ agent: "owner", output: "owner done", success: true }],
					sessionId: "session-1",
					intercomTarget: "subagent-chat-main",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				watcher.stopResultWatcher();
			}

			assert.equal(fs.existsSync(resultPath), false);

			const completion = emitted.find((entry) => entry.event === "subagent:async-complete")?.data as { nestedChildren?: Array<{ id?: string }>; results?: Array<{ children?: Array<{ id?: string }> }> } | undefined;
			assert.equal(completion?.nestedChildren?.[0]?.id, "nested-child");
			assert.equal(completion?.results?.[0]?.children?.[0]?.id, "nested-child");
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

	it("filters malformed explicit nested children in result files before compacting", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-nested-malformed-"));
		try {
			const events = createRecordingEventBus({ acknowledgeResultIntercom: true });
			const pi = { events };
			const emitted = events.emitted;
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const resultPath = path.join(resultsDir, "async-explicit-nested.json");
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			try {
				fs.writeFileSync(resultPath, JSON.stringify({
					id: "async-explicit-nested",
					runId: "async-explicit-nested",
					agent: "owner",
					mode: "single",
					success: true,
					state: "complete",
					summary: "owner done",
					results: [{
						agent: "owner",
						output: "owner done",
						success: true,
						children: [
							{ id: "child-explicit-good", parentRunId: "async-explicit-nested", depth: 1, path: [{ runId: "async-explicit-nested" }], state: "complete", agent: "child-good" },
							{ id: "child-explicit-bad", path: "not-an-array" },
						],
					}],
					nestedChildren: [
						{ id: "top-explicit-good", parentRunId: "async-explicit-nested", parentStepIndex: 0, depth: 1, path: [{ runId: "async-explicit-nested", stepIndex: 0 }], state: "complete", agent: "top-good" },
						{ id: "top-explicit-bad", path: "not-an-array" },
					],
					sessionId: "session-1",
					intercomTarget: "subagent-chat-main",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(fs.existsSync(resultPath), false);
			assert.ok(logged.some((entry) => String(entry[0] ?? "").includes(resultPath) && /invalid nested child record/.test(String(entry[0] ?? ""))));

			const completion = emitted.find((entry) => entry.event === "subagent:async-complete")?.data as { results?: Array<{ children?: Array<{ id?: string }> }>; nestedChildren?: Array<{ id?: string }> } | undefined;
			assert.deepEqual(completion?.nestedChildren?.map((child) => child.id), ["top-explicit-good"]);
			assert.deepEqual(completion?.results?.[0]?.children?.map((child) => child.id)?.sort(), ["child-explicit-good", "top-explicit-good"].sort());
		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
		}
	});

	it("retries and delivers result files after nested registry enrichment recovers", async () => {
		const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-result-watcher-nested-retry-"));
		const route = createNestedRoute("async-nested-retry");
		try {
			const registryPath = path.join(path.dirname(route.eventSink), "registry.json");
			fs.writeFileSync(registryPath, "{", "utf-8");
			writeNestedEvent(route, {
				type: "subagent.nested.completed",
				ts: 100,
				parentRunId: "async-nested-retry",
				parentStepIndex: 0,
				child: {
					id: "nested-retry-child",
					parentRunId: "async-nested-retry",
					parentStepIndex: 0,
					depth: 1,
					path: [{ runId: "async-nested-retry", stepIndex: 0 }],
					state: "complete",
					agent: "child",
				},
			});
			const events = createRecordingEventBus({ acknowledgeResultIntercom: true });
			const pi = { events };
			const emitted = events.emitted;
			const state = createState();
			state.currentSessionId = "session-1";
			const watcher = createResultWatcher(pi, state, resultsDir, 60_000);
			const resultPath = path.join(resultsDir, "async-nested-retry.json");
			const originalError = console.error;
			const logged: unknown[][] = [];
			console.error = (...args: unknown[]) => {
				logged.push(args);
			};
			try {
				fs.writeFileSync(resultPath, JSON.stringify({
					id: "async-nested-retry",
					runId: "async-nested-retry",
					agent: "owner",
					success: true,
					state: "complete",
					summary: "owner done",
					sessionId: "session-1",
					intercomTarget: "subagent-chat-main",
				}), "utf-8");
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 100));

				assert.equal(fs.existsSync(resultPath), true);
				assert.equal(emitted.length, 0);
				assert.ok(
					logged.some((entry) => /will retry later/.test(String(entry[0] ?? ""))),
					"expected nested enrichment retry warning to be logged",
				);

				fs.rmSync(registryPath, { force: true });
				watcher.primeExistingResults();
				await new Promise((resolve) => setTimeout(resolve, 650));
			} finally {
				console.error = originalError;
				watcher.stopResultWatcher();
			}

			assert.equal(fs.existsSync(resultPath), false);
			const completion = emitted.find((entry) => entry.event === "subagent:async-complete")?.data as { nestedChildren?: Array<{ id?: string }> } | undefined;
			assert.deepEqual(completion?.nestedChildren?.map((child) => child.id), ["nested-retry-child"]);

		} finally {
			fs.rmSync(resultsDir, { recursive: true, force: true });
			fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
		}
	});

});
