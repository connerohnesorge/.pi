import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import {
  createPerCallDeferredAgent,
  deferredAgent,
  makeTempCwdWrapper,
  oneAgentScript,
  twoAgentScript,
  wait,
} from "./helpers/workflow-test-helpers.js";

const withTempCwd = makeTempCwdWrapper("pi-dw-abort-");

// ─── Abort Propagation (3 tests) ───────────────────────────────────────────────

test(
  "abort via externalSignal propagates through workflow execution and yields WorkflowError",
  withTempCwd(async (cwd) => {
    const ac = new AbortController();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    let errorEmitted = false;
    manager.on("error", () => {
      errorEmitted = true;
    });

    const runPromise = manager.runSync(oneAgentScript, undefined, {
      externalSignal: ac.signal,
    });

    // Let the agent start (deferred, so it hangs inside agentRunner.run())
    await wait(20);

    // Abort from outside — this triggers managed.controller.abort()
    ac.abort();

    // Resolve the deferred agent so the in-flight agent completes,
    // then throwIfAborted() fires and the error propagates.
    da.resolve("done");

    try {
      await runPromise;
      assert.fail("runSync should have thrown on abort");
    } catch (err) {
      assert.ok(err instanceof WorkflowError, "error should be WorkflowError");
      assert.equal(
        (err as WorkflowError).code,
        WorkflowErrorCode.WORKFLOW_ABORTED,
        "error code should be WORKFLOW_ABORTED",
      );
      assert.ok((err as WorkflowError).recoverable, "abort error should be recoverable");
    }

    assert.equal(errorEmitted, true, "manager should emit 'error' event on abort");
  }),
);

test(
  "abort via externalSignal does not crash Pi (no uncaught exception)",
  withTempCwd(async (cwd) => {
    const ac = new AbortController();
    const da = deferredAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});

    let uncaughtFromTest: Error | null = null;
    const errorHandler = (err: Error) => {
      uncaughtFromTest = err;
    };
    process.on("uncaughtException", errorHandler);

    try {
      const runPromise = manager.runSync(oneAgentScript, undefined, {
        externalSignal: ac.signal,
      });
      await wait(20);
      ac.abort();
      da.resolve("done");

      try {
        await runPromise;
      } catch {
        // Expected — abort throws WorkflowError
      }

      // Give microtasks a chance to settle
      await wait(20);

      assert.equal(uncaughtFromTest, null, "abort should NOT produce an uncaught exception");
    } finally {
      process.off("uncaughtException", errorHandler);
    }
  }),
);

test(
  "abort mid-way through multi-agent workflow: remaining agents are skipped",
  withTempCwd(async (cwd) => {
    const multiDa = createPerCallDeferredAgent();

    const manager = new WorkflowManager({ cwd, agent: multiDa.runner });
    manager.on("error", () => {});

    const { runId, promise } = manager.startInBackground(twoAgentScript);
    await wait(20);

    // Let agent 1 complete (gets journaled)
    multiDa.resolve(0, "first-done");
    // Wait for agent 1's result to be journaled and agent 2 to start
    await wait(30);

    // Stop the run while agent 2 is in-flight
    const stopped = manager.stop(runId);
    assert.equal(stopped, true, "stop should succeed");

    // Resolve agent 2 so the abort/throwIfAborted path executes
    multiDa.resolve(1, "second-done");
    await promise.catch(() => {});

    // Verify the run is aborted
    const persisted = manager.listRuns().find((r) => r.runId === runId);
    assert.equal(persisted?.status, "aborted", "run should be aborted after stop");

    // Verify the error is a WorkflowError
    const managedRun = manager.getRun(runId);
    assert.ok(managedRun?.error instanceof WorkflowError, "error should be instance of WorkflowError");
    assert.equal((managedRun.error as WorkflowError).code, WorkflowErrorCode.WORKFLOW_ABORTED);
  }),
);
