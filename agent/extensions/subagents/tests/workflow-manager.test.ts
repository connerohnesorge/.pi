import assert from "node:assert/strict";
import test from "node:test";
import type { AgentUsage } from "../src/agent.ts";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.ts";
import { WorkflowManager } from "../src/workflow-manager.ts";
import { deferredAgent, fakeAgent, oneAgentScript, withTempCwd } from "./helpers/workflow-manager-fixtures.ts";

async function stopAbortedRun(manager: WorkflowManager, runId: string, promise: Promise<unknown>, da: ReturnType<typeof deferredAgent>) {
  assert.equal(manager.stop(runId), true);
  assert.equal(manager.getRun(runId)?.status, "aborted");
  da.resolve("done");
  await promise.catch(() => {});
}

async function settleOriginalRun(da: ReturnType<typeof deferredAgent>, origPromise: Promise<unknown>) {
  da.runner.run = async (_prompt: string) => "done";
  da.resolve("done");
  await origPromise.catch(() => {});
}

function failAgentOnResume(da: ReturnType<typeof deferredAgent>) {
  test.mock.method(da.runner, "run", async (_prompt: string) => {
    throw new WorkflowError("fatal agent error", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
  });
}

function delayedAgent(delayMs: number, result: unknown = "slow") {
  return {
    async run(_prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      options?.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
      });
      return result;
    },
  };
}

function quotaLimitedAgent(isLimitActive: () => boolean) {
  return {
    async run(prompt: string) {
      if (prompt.includes("second") && isLimitActive()) {
        throw new WorkflowError(
          "Codex usage limit reached (plus plan). Resets in ~3h.",
          WorkflowErrorCode.PROVIDER_USAGE_LIMIT,
          { recoverable: false, resetHint: "Resets in ~3h" },
        );
      }
      return prompt.includes("first") ? "first-result" : "second-result";
    },
  };
}

function capturePausedEvents(manager: WorkflowManager) {
  const pausedEvents: Array<{ runId: string; reason?: string; resetHint?: string }> = [];
  manager.on("paused", (e: { runId: string; reason?: string; resetHint?: string }) => pausedEvents.push(e));
  return pausedEvents;
}

function assertUsageLimitPausedRun(
  manager: WorkflowManager,
  runId: string,
  pausedEvents: Array<{ runId: string; reason?: string; resetHint?: string }>,
) {
  assert.equal(manager.getRun(runId)?.status, "paused");
  const persisted = manager.listRuns().find((r) => r.runId === runId);
  assert.ok(persisted);
  assert.equal(persisted.status, "paused");
  assert.equal(persisted.pauseReason, "usage_limit");
  assert.equal(persisted.resetHint, "Resets in ~3h");
  assert.ok(persisted.journal);
  assert.ok(persisted.journal.length >= 1, "agent 1's result should be journaled");

  assert.equal(pausedEvents.length, 1);
  assert.equal(pausedEvents[0].reason, "usage_limit");
  assert.equal(pausedEvents[0].resetHint, "Resets in ~3h");
}

function assertUsageLimitResumedRun(manager: WorkflowManager, runId: string) {
  const finalRun = manager.getRun(runId);
  assert.equal(finalRun?.status, "completed", "resumed run completes once the limit clears");
  assert.equal(finalRun?.result?.result?.a, "first-result");
  assert.equal(finalRun?.result?.result?.b, "second-result");
}

test(
  "runSync registers the run so /workflows (listRuns) can see it",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ input: 100, output: 40, total: 140 }) });
    const events: string[] = [];
    for (const ev of ["agentStart", "agentEnd", "phase", "complete"]) {
      manager.on(ev, () => events.push(ev));
    }
    let progressCalls = 0;
    const result = await manager.runSync(oneAgentScript, undefined, {
      onProgress: () => {
        progressCalls++;
      },
    });

    assert.equal(result.agentCount, 1);
    assert.ok(progressCalls > 0, "onProgress should fire while the run executes");
    assert.ok(events.includes("agentStart") && events.includes("complete"), "manager emits live events");

    const runs = manager.listRuns();
    assert.equal(runs.length, 1, "the sync run is persisted and listable");
    assert.equal(runs[0].workflowName, "tracked_demo");
    assert.equal(runs[0].status, "completed");
    assert.equal(runs[0].tokenUsage?.total, 140, "token usage is persisted for the navigator");
  }),
);

test(
  "manager defaultAgentTimeoutMs applies when run options omit agentTimeoutMs",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: delayedAgent(25), defaultAgentTimeoutMs: 5 });

    const result = await manager.runSync(oneAgentScript);

    assert.equal((result.result as { a: unknown }).a, null);
    const agent = manager.listRuns()[0]?.agents[0];
    assert.equal(agent?.status, "error");
    assert.match(agent?.error ?? "", /timed out after 5ms/);
    assert.match(agent?.error ?? "", /raise or omit timeoutMs\/agentTimeoutMs/);
  }),
);

test(
  "run option agentTimeoutMs overrides manager defaultAgentTimeoutMs",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: delayedAgent(25), defaultAgentTimeoutMs: 5 });

    const result = await manager.runSync(oneAgentScript, undefined, { agentTimeoutMs: null });

    assert.equal((result.result as { a: unknown }).a, "slow");
    const agent = manager.listRuns()[0]?.agents[0];
    assert.equal(agent?.status, "done");
  }),
);

test(
  "manager forwards exec concurrency and agentRetries to runtime",
  withTempCwd(async (cwd) => {
    let active = 0;
    let maxActive = 0;
    const callsByPrompt = new Map<string, number>();
    const manager = new WorkflowManager({
      cwd,
      concurrency: 8,
      defaultAgentRetries: 0,
      agent: {
        async run(prompt: string) {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          const calls = (callsByPrompt.get(prompt) ?? 0) + 1;
          callsByPrompt.set(prompt, calls);
          return calls === 1 ? "" : `ok:${prompt}`;
        },
      },
    });
    const script = `export const meta = { name: 'forwarding', description: 'manager controls' }
const xs = await parallel(['a','b'].map((p) => () => agent(p, { label: p })))
return xs`;

    const result = await manager.runSync(script, undefined, { concurrency: 1, agentRetries: 1 });

    assert.deepEqual(result.result, ["ok:a", "ok:b"]);
    assert.equal(maxActive, 1, "exec concurrency should override the manager default");
    assert.deepEqual([...callsByPrompt.values()], [2, 2], "exec agentRetries should be forwarded");
  }),
);

test(
  "manager defaultAgentRetries applies when run options omit agentRetries",
  withTempCwd(async (cwd) => {
    let calls = 0;
    const manager = new WorkflowManager({
      cwd,
      defaultAgentRetries: 1,
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
    });

    const result = await manager.runSync(oneAgentScript);

    assert.equal((result.result as { a: unknown }).a, "ok");
    assert.equal(calls, 2);
  }),
);

test(
  "runSync persists the run immediately (visible while still running)",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    let listedWhileRunning = 0;
    manager.on("agentStart", () => {
      listedWhileRunning = manager.listRuns().filter((r) => r.status === "running").length;
    });
    await manager.runSync(oneAgentScript);
    assert.equal(listedWhileRunning, 1, "the run shows as running in listRuns mid-flight");
  }),
);

test(
  "runSync persists workflow agent session files",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      sessionFile: "/tmp/parent-session.jsonl",
      agent: {
        async run(_prompt: string, options?: any) {
          assert.match(options?.sessionDir ?? "", /agent-sessions/);
          assert.equal(options?.parentSessionFile, "/tmp/parent-session.jsonl");
          options?.onSession?.({ sessionFile: "/tmp/workflow-agent.jsonl", sessionId: "s1" });
          return "done";
        },
      },
    });

    await manager.runSync(oneAgentScript);

    const run = manager.listRuns()[0];
    const agent = run?.agents[0];
    assert.equal(agent?.sessionFile, "/tmp/workflow-agent.jsonl");
    assert.equal(run?.originSessionFile, "/tmp/parent-session.jsonl");
  }),
);

test(
  "each agent's model is recorded for /workflows: explicit opts.model, else the main model",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent(), mainModel: "anthropic/claude-opus-4-8" });
    const script = `export const meta = { name: 'model_demo', description: 'per-agent models' }
const a = await agent('explore', { label: 'scan', model: 'openai/gpt-5-mini' })
const b = await agent('reason', { label: 'judge' })
return { a, b }`;
    await manager.runSync(script);

    const run = manager.listRuns().find((r) => r.workflowName === "model_demo");
    const byLabel = Object.fromEntries((run?.agents ?? []).map((a) => [a.label, a.model]));
    assert.equal(byLabel.scan, "openai/gpt-5-mini", "explicit per-agent model is recorded");
    assert.equal(byLabel.judge, "anthropic/claude-opus-4-8", "default agent shows the main model");
  }),
);

test(
  "runSync persists recoverable agent error details for /workflows",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new Error("agent exploded");
        },
      },
    });

    await manager.runSync(oneAgentScript);

    const run = manager.listRuns().find((r) => r.workflowName === "tracked_demo");
    const agent = run?.agents[0];
    assert.equal(agent?.status, "error");
    assert.equal(agent?.error, "agent exploded");
    assert.equal(agent?.errorCode, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
    assert.equal(agent?.recoverable, true);
  }),
);

test(
  "runSync stores compact subagent history for /workflows detail",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(_prompt: string, options: { onHistory?: (history: unknown[]) => void }) {
          options.onHistory?.([{ role: "assistant", kind: "text", text: "inspecting files" }]);
          return "ok";
        },
      },
    });

    await manager.runSync(oneAgentScript);

    const run = manager.listRuns().find((r) => r.workflowName === "tracked_demo");
    const agent = run?.agents[0];
    assert.equal(agent?.history?.length, 1);
    assert.equal(agent?.history?.[0]?.text, "inspecting files");
  }),
);

test(
  "startInBackground returns immediately with runId and promise",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    assert.ok(runId, "should generate a run id");
    assert.ok(promise instanceof Promise, "should return a promise");
    const runs = manager.listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runId, runId);
    assert.equal(runs[0].status, "running");
    await promise;
  }),
);

test(
  "startInBackground result resolves on completion",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent({ total: 50 }) });
    const { promise } = manager.startInBackground(oneAgentScript);
    const result = await promise;
    assert.equal(result.agentCount, 1);
    assert.equal(result.meta.name, "tracked_demo");
  }),
);

test(
  "stop stops a running workflow and transitions to aborted",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    // Suppress the expected unhandled rejection from the aborted run
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    // Wait a tick for the run to start processing
    await new Promise((r) => setTimeout(r, 20));
    const stopped = manager.stop(runId);
    assert.equal(stopped, true);
    const run = manager.getRun(runId);
    assert.equal(run?.status, "aborted", "run should be aborted");
    // Clean up: resolve the deferred agent and catch the expected rejection
    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "stop returns false for nonexistent run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    assert.equal(manager.stop("nonexistent"), false);
  }),
);

test(
  "pause pauses a running workflow",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    const paused = manager.pause(runId);
    assert.equal(paused, true);
    const run = manager.getRun(runId);
    assert.equal(run?.status, "paused", "run should be paused");
    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "pause returns false for nonexistent run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    assert.equal(manager.pause("nonexistent"), false);
  }),
);

test(
  "getRun returns undefined for unknown run id",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const run = manager.getRun("no-such-run");
    assert.equal(run, undefined);
  }),
);

test(
  "getSnapshot returns null for unknown run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const snap = manager.getSnapshot("unknown");
    assert.equal(snap, null);
  }),
);

test(
  "deleteRun removes the run from memory and persistence",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId } = manager.startInBackground(oneAgentScript);
    // Wait for completion first (fast agent)
    await new Promise((r) => setTimeout(r, 30));
    const deleted = manager.deleteRun(runId);
    assert.equal(deleted, true);
    assert.equal(manager.getRun(runId), undefined);
  }),
);

test(
  "deleteRun returns false for nonexistent run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    assert.equal(manager.deleteRun("nonexistent"), false);
  }),
);

test(
  "setModelRegistry stores the registry and forwards it to subagent runs",
  withTempCwd(async (cwd) => {
    const fakeRegistry = {
      getAvailable: () => [{ provider: "mock", id: "m" }],
      find: () => undefined,
      getAll: () => [],
    } as any;
    const rec = new (class {
      calls: Array<{ options: any }> = [];
      async run(_prompt: string, options: any) {
        this.calls.push({ options });
        options.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
        return "ok";
      }
    })();
    const manager = new WorkflowManager({ cwd, agent: rec });
    manager.setModelRegistry(fakeRegistry);
    await manager.runSync(oneAgentScript);
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].options.modelRegistry, fakeRegistry);
  }),
);

test(
  "setMainModel sets the main model used for default agents",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    manager.setMainModel("anthropic/claude-sonnet-4");
    const script = `export const meta = { name: 'mm_test', description: 'main model test' }
const a = await agent('test', { label: 'a' })
return { a }`;
    await manager.runSync(script);
    const run = manager.listRuns().find((r) => r.workflowName === "mm_test");
    assert.ok(run, "run should exist");
  }),
);

test(
  "getPersistence returns the persistence layer",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const p = manager.getPersistence();
    assert.ok(p, "p should be truthy");
    assert.equal(typeof p.save, "function");
    assert.equal(typeof p.list, "function");
  }),
);

test(
  "runSync emits manager events (agentStart -> agentEnd -> complete)",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const events: string[] = [];
    manager.on("agentStart", () => events.push("agentStart"));
    manager.on("agentEnd", () => events.push("agentEnd"));
    manager.on("complete", () => events.push("complete"));
    await manager.runSync(oneAgentScript);
    assert.deepEqual(events, ["agentStart", "agentEnd", "complete"]);
  }),
);

test(
  "resume returns false when run is already running",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));
    const resumed = await manager.resume(runId);
    assert.equal(resumed, false);
    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "resume returns false when run doesn't exist",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const resumed = await manager.resume("nonexistent");
    assert.equal(resumed, false);
  }),
);

test(
  "manager emits complete event with runId",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    let capturedId = "";
    manager.on("complete", ({ runId }: { runId: string }) => {
      capturedId = runId;
    });
    await manager.runSync(oneAgentScript);
    assert.ok(capturedId, "should capture runId on complete");
  }),
);

test(
  "stop returns false for completed/aborted run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise; // wait for completion
    const stopped = manager.stop(runId);
    assert.equal(stopped, false, "cannot stop an already completed run");
  }),
);

test(
  "pause returns false for completed run",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise; // wait for completion
    const paused = manager.pause(runId);
    assert.equal(paused, false, "cannot pause completed run");
  }),
);

test(
  "a provider usage limit pauses the run (not failed) and is resumable, replaying the journal",
  withTempCwd(async (cwd) => {
    let limitActive = true;
    const manager = new WorkflowManager({ cwd, agent: quotaLimitedAgent(() => limitActive) });
    const pausedEvents = capturePausedEvents(manager);

    const twoAgentScript = `export const meta = { name: 'quota_demo', description: 'two agents' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

    const { runId, promise } = manager.startInBackground(twoAgentScript);
    await promise.catch(() => {}); // settles: rejects with PROVIDER_USAGE_LIMIT
    assertUsageLimitPausedRun(manager, runId, pausedEvents);

    limitActive = false;
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    await new Promise((r) => setTimeout(r, 50));
    assertUsageLimitResumedRun(manager, runId);
  }),
);

test(
  "a non-quota non-recoverable agent error still fails the run (control)",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new WorkflowError("schema bad", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false });
        },
      },
    });
    manager.on("error", () => {});
    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "failed");
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.pauseReason, undefined, "a real failure carries no usage-limit pause reason");
  }),
);

// ─── Cold-start resume tests ────────────────────────────────────────────────────
// These tests manually persist runs via the persistence layer (as though the
// process was restarted) and then resume them from disk — no in-memory state.

test(
  "cold-start resume: persisted run can be resumed from disk",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const pers = manager.getPersistence();
    const runId = "cold-start-ok-1";

    // Manually save a persisted run — cold-start scenario, no in-memory state
    pers.save({
      runId,
      workflowName: "cold_start",
      script: oneAgentScript,
      args: undefined,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // No in-memory run exists at this point; resume loads from persistence
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true, "resume should succeed for cold-start persisted run");

    // Wait for the background execution (fake agent resolves instantly)
    await new Promise((r) => setTimeout(r, 100));

    const run = manager.getRun(runId);
    assert.ok(run, "run should be in memory after resume");
    assert.equal(run?.status, "completed", "cold-start resumed run should complete");
    assert.equal(run?.result?.result?.a, "ok", "agent result should be present");

    // Verify persistence was updated to completed
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "completed", "persistence should reflect completed status");
  }),
);

test(
  "cold-start resume: completed run cannot be resumed",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const pers = manager.getPersistence();
    const runId = "cold-start-completed-1";

    pers.save({
      runId,
      workflowName: "completed_test",
      script: oneAgentScript,
      args: undefined,
      status: "completed",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const resumed = await manager.resume(runId);
    assert.equal(resumed, false, "completed persisted run cannot be resumed");
  }),
);

test(
  "cold-start resume: persisted run with empty script cannot be resumed",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const pers = manager.getPersistence();
    const runId = "cold-start-noscript-1";

    pers.save({
      runId,
      workflowName: "no_script_test",
      script: "",
      args: undefined,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const resumed = await manager.resume(runId);
    assert.equal(resumed, false, "persisted run with empty script cannot be resumed");
  }),
);

test(
  "cold-start resume: a second manager cannot resume a run while another manager owns the lease",
  withTempCwd(async (cwd) => {
    const ownerAgent = deferredAgent();
    const owner = new WorkflowManager({ cwd, agent: ownerAgent.runner });
    owner.on("error", () => {});
    const runId = "cold-start-leased-1";
    owner.getPersistence().save({
      runId,
      workflowName: "leased",
      script: oneAgentScript,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    assert.equal(await owner.resume(runId), true, "first manager should acquire the lease and start");
    await new Promise((r) => setTimeout(r, 20));

    const contender = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          assert.fail("second manager must not run an agent without the lease");
        },
      },
    });
    assert.equal(await contender.resume(runId), false, "second manager should be refused by the live lease");

    ownerAgent.resolve("done");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(owner.getRun(runId)?.status, "completed", "leased owner should still finish");
  }),
);

test(
  "cold-start recovery leaves a live leased running run untouched",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd });
    const pers = manager.getPersistence();
    const runId = "live-running-lease";
    pers.save({
      runId,
      workflowName: "live",
      script: oneAgentScript,
      status: "running",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const lease = pers.acquireRunLease(runId);
    assert.ok(lease, "test setup should acquire the live lease");

    try {
      new WorkflowManager({ cwd });
      assert.equal(pers.load(runId)?.status, "running", "live leased run is not recovered to paused");
    } finally {
      pers.releaseRunLease(lease);
    }
  }),
);

test(
  "cold-start resume releases the lease after failure so another manager can retry",
  withTempCwd(async (cwd) => {
    const failing = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          throw new WorkflowError("boom", WorkflowErrorCode.UNKNOWN, { recoverable: false });
        },
      },
    });
    failing.on("error", () => {});
    const runId = "failed-lease-retry";
    failing.getPersistence().save({
      runId,
      workflowName: "failed_once",
      script: oneAgentScript,
      status: "paused",
      phases: [],
      agents: [],
      logs: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    assert.equal(await failing.resume(runId), true, "first resume starts");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(failing.getRun(runId)?.status, "failed", "first resume failed");

    const retry = new WorkflowManager({ cwd, agent: fakeAgent() });
    assert.equal(await retry.resume(runId), true, "failed run can be resumed after lease release");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(retry.getRun(runId)?.status, "completed", "retry manager completed the run");
  }),
);

// ─── State transition tests ─────────────────────────────────────────────────

test(
  "state transition: running -> pause -> running (pause then resume cycle)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // running -> pause -> running
    assert.equal(manager.getRun(runId)?.status, "running", "should start as running");
    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused", "should be paused after pause");

    const resumed = await manager.resume(runId);
    assert.equal(resumed, true);
    assert.equal(manager.getRun(runId)?.status, "running", "should be running after resume");

    // Complete the resumed run
    da.resolve("resumed-done");
    await origPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(manager.getRun(runId)?.status, "completed", "should complete after resume finishes");
  }),
);

test(
  "state transition: running -> stop (direct stop while running)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(manager.getRun(runId)?.status, "running");
    await stopAbortedRun(manager, runId, promise, da);
  }),
);

test(
  "state transition: running -> pause -> stop (pause then stop)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    await stopAbortedRun(manager, runId, promise, da);
  }),
);

test(
  "state transition: running -> stop -> resume (stop then try resume -> false)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(manager.stop(runId), true);
    assert.equal(manager.getRun(runId)?.status, "aborted");

    const resumed = await manager.resume(runId);
    assert.equal(resumed, false, "cannot resume a stopped/aborted run");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "state transition: completed -> resume (completed run cannot be resumed -> false)",
  withTempCwd(async (cwd) => {
    const agentObj = fakeAgent();
    const runMock = test.mock.method(agentObj, "run");
    const manager = new WorkflowManager({ cwd, agent: agentObj });
    const { promise } = manager.startInBackground(oneAgentScript);
    await promise;

    const runs = manager.listRuns();
    const runId = runs[0]?.runId;
    assert.ok(runId);
    assert.equal(runs[0].status, "completed");
    assert.equal(runMock.mock.callCount(), 1, "agent.run should have been called once");

    const resumed = await manager.resume(runId);
    assert.equal(resumed, false, "cannot resume a completed run");
  }),
);

test(
  "state transition: running -> pause -> pause (double pause -> false)",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    assert.equal(manager.pause(runId), false, "second pause should return false");
    assert.equal(manager.getRun(runId)?.status, "paused", "status should remain paused");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

// ─── Concurrency / race tests ──────────────────────────────────────────────────

test(
  "double resume on a persisted paused run returns false on second call",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause while running so we can resume
    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    // First resume should succeed
    const firstResume = await manager.resume(runId);
    assert.equal(firstResume, true, "first resume should succeed");

    // The resumed run is now running; second resume should return false
    const secondResume = await manager.resume(runId);
    assert.equal(secondResume, false, "second resume should return false when the resumed run is already running");

    da.resolve("done");
    await origPromise.catch(() => {});
  }),
);

test(
  "concurrent pause and stop produces deterministic aborted state",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Call pause and stop without awaiting — synchronous in the event loop
    const _pauseResult = manager.pause(runId);
    const _stopResult = manager.stop(runId);

    // Final state must always be "aborted" because:
    //   pause transitions "running" → "paused"
    //   stop transitions "running" or "paused" → "aborted", never back to "paused"
    // Ordering 1: pause then stop → paused then aborted
    // Ordering 2: stop then pause → aborted, pause returns false
    // In every ordering: final status is "aborted".
    assert.equal(manager.getRun(runId)?.status, "aborted", "final status must be aborted regardless of ordering");

    da.resolve("done");
    await promise.catch(() => {});
  }),
);

test(
  "agent error during resume sets run to failed status",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause while the deferred agent is in-flight
    assert.equal(manager.pause(runId), true);
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Mock the agent runner to throw a non-recoverable WorkflowError on resume.
    // Regular Error/agent rejections get wrapped as recoverable (agent returns
    // null, workflow continues). A non-recoverable WorkflowError propagates up
    // to executeRun's catch block and sets status to "failed".
    failAgentOnResume(da);

    try {
      // Resume — executeRun calls runWorkflow which calls the mocked runner
      const resumed = await manager.resume(runId);
      assert.equal(resumed, true, "resume should schedule the run");

      // Wait for the background executed run to process the agent error
      await new Promise((r) => setTimeout(r, 100));

      const finalRun = manager.getRun(runId);
      assert.equal(finalRun?.status, "failed", "resumed run should transition to failed when agent errors");
      assert.ok(finalRun?.error instanceof WorkflowError, "error should be a WorkflowError");
      assert.equal(
        (finalRun?.error as WorkflowError).code,
        WorkflowErrorCode.AGENT_EXECUTION_ERROR,
        "error code should be AGENT_EXECUTION_ERROR",
      );
    } finally {
      // Resolve the original deferred promise so the first executeRun settles
      await settleOriginalRun(da, origPromise);
    }
  }),
);

test(
  "two concurrent background runs are both tracked immediately in listRuns",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const r1 = manager.startInBackground(oneAgentScript);
    const r2 = manager.startInBackground(oneAgentScript);

    // Both runs should be immediately visible in listRuns
    const runs = manager.listRuns();
    assert.equal(runs.length, 2, "both runs should appear in listRuns immediately after startInBackground");

    // Both should be in running status
    assert.equal(manager.getRun(r1.runId)?.status, "running");
    assert.equal(manager.getRun(r2.runId)?.status, "running");

    // Run IDs must be unique
    assert.notEqual(r1.runId, r2.runId);

    da.resolve("done");
    await Promise.allSettled([r1.promise, r2.promise]);
  }),
);

// ─── Failed state transition tests ─────────────────────────────────────────────

test(
  "pause returns false for failed run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause the running run so we can resume with a failing agent
    assert.equal(manager.pause(runId), true, "pause should succeed");
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Mock agent to throw a non-recoverable WorkflowError, making the run fail
    failAgentOnResume(da);

    try {
      // Resume — the run will fail because the mocked agent throws
      const resumed = await manager.resume(runId);
      assert.equal(resumed, true, "resume should schedule the run");
      await new Promise((r) => setTimeout(r, 100));

      // Verify the run is now in failed state
      const failedRun = manager.getRun(runId);
      assert.equal(failedRun?.status, "failed", "run should be in failed state");
      assert.ok(failedRun?.error instanceof WorkflowError, "error should be a WorkflowError");

      // pause() should return false for a failed run (requires status === "running")
      const paused = manager.pause(runId);
      assert.equal(paused, false, "pause should return false for failed run");
      assert.equal(manager.getRun(runId)?.status, "failed", "status should remain failed after rejected pause");
    } finally {
      await settleOriginalRun(da, origPromise);
    }
  }),
);

test(
  "stop returns false for failed run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause the running run so we can resume with a failing agent
    assert.equal(manager.pause(runId), true, "pause should succeed");
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Mock agent to throw a non-recoverable WorkflowError
    failAgentOnResume(da);

    try {
      // Resume — the run will fail
      const resumed = await manager.resume(runId);
      assert.equal(resumed, true, "resume should schedule the run");
      await new Promise((r) => setTimeout(r, 100));

      // Verify the run is now in failed state
      const failedRun = manager.getRun(runId);
      assert.equal(failedRun?.status, "failed", "run should be in failed state");
      assert.ok(failedRun?.error instanceof WorkflowError, "error should be a WorkflowError");

      // stop() should return false for a failed run (requires "running" or "paused")
      const stopped = manager.stop(runId);
      assert.equal(stopped, false, "stop should return false for failed run");
      assert.equal(manager.getRun(runId)?.status, "failed", "status should remain failed after rejected stop");
    } finally {
      await settleOriginalRun(da, origPromise);
    }
  }),
);

test(
  "resume restarts a failed run",
  withTempCwd(async (cwd) => {
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    const { runId, promise: origPromise } = manager.startInBackground(oneAgentScript);
    await new Promise((r) => setTimeout(r, 20));

    // Pause the running run
    assert.equal(manager.pause(runId), true, "pause should succeed");
    assert.equal(manager.getRun(runId)?.status, "paused");

    // Mock agent to throw a non-recoverable WorkflowError
    failAgentOnResume(da);

    try {
      // Resume — the run will fail
      await manager.resume(runId);
      await new Promise((r) => setTimeout(r, 100));

      // Verify the run is now in failed state
      const failedRun = manager.getRun(runId);
      assert.equal(failedRun?.status, "failed", "run should be in failed state");
      assert.ok(failedRun?.error instanceof WorkflowError, "error should be a WorkflowError");
    } finally {
      // Restore the runner so the resumed run's agent call succeeds
      await settleOriginalRun(da, origPromise);
    }

    // Resume the failed run — resume() allows failed status
    const resumed = await manager.resume(runId);
    assert.equal(resumed, true, "resume should return true for a failed run");
    assert.equal(manager.getRun(runId)?.status, "running", "resumed failed run should transition to running");

    // Wait for the resumed run to complete successfully
    await new Promise((r) => setTimeout(r, 100));

    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed", "resumed failed run should complete successfully after restore");
  }),
);

// ─── parallel() concurrency tests ───────────────────────────────────────────

test(
  "parallel executes all items",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const script = `export const meta = { name: 'parallel_count', description: 'count parallel agents' }
const results = await parallel([1,2,3].map(n => () => agent('task ' + n)))
return results`;
    const result = await manager.runSync(script);
    assert.equal(result.agentCount, 3, "parallel should execute all 3 agents");
    assert.ok(Array.isArray(result.result), "result should be an array");
    assert.equal(result.result.length, 3);
  }),
);

test(
  "parallel returns results in order",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string) {
          return prompt;
        },
      },
    });
    const script = `export const meta = { name: 'parallel_order', description: 'check parallel order' }
const results = await parallel([1,2,3].map(n => () => agent('task ' + n)))
return results`;
    const result = await manager.runSync(script);
    assert.equal(result.agentCount, 3, "3 agents should have run");
    assert.deepEqual(result.result, ["task 1", "task 2", "task 3"], "parallel should return results in input order");
  }),
);

test(
  "parallel with empty array returns empty",
  withTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: fakeAgent() });
    const script = `export const meta = { name: 'parallel_empty', description: 'empty parallel' }
const results = await parallel([])
return results`;
    const result = await manager.runSync(script);
    assert.ok(Array.isArray(result.result), "result should be an array");
    assert.equal(result.result.length, 0, "empty parallel should return empty array");
    assert.equal(result.agentCount, 0, "no agents should run with empty parallel");
  }),
);
