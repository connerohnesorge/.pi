/**
 * Real-session integration test for issue #26 — provider usage-limit handling.
 *
 * Every other test injects a fake agent runner; this one drives the REAL
 * `WorkflowAgent.run` → `createAgentSession` path and uses the pi SDK's built-in
 * FAUX provider to end a turn in a "usage limit reached" error (stopReason
 * "error" + errorMessage), exactly as a real provider buries a quota exhaustion.
 * It is the contract guard for the load-bearing SDK assumption behind the fix:
 * a usage limit surfaces as an error-status assistant message, not a thrown error.
 * No network call is made and NO provider quota is consumed.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { WorkflowAgent } from "../src/agent.ts";
import { WorkflowErrorCode } from "../src/errors.ts";
import { WorkflowManager } from "../src/workflow-manager.ts";
import { withFakeHomeAsync } from "./helpers/fake-home.ts";

const USAGE_LIMIT_MSG = "Codex usage limit reached (plus plan). Resets in ~3h.";

/**
 * Run `fn` with an isolated HOME and a dummy provider key so hasConfiguredAuth()
 * passes via env — no real credentials are touched, and the faux api means the
 * key is never actually used. A faux "deepseek" provider is registered/torn down
 * around `fn`; `setResponses` queues the scripted turns.
 */
type FauxSessionContext = {
  cwd: string;
  model: unknown;
  setResponses: (msgs: unknown[]) => void;
  fauxAssistantMessage: typeof import("@earendil-works/pi-ai").fauxAssistantMessage;
};

async function withFauxSession(fn: (ctx: FauxSessionContext) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "pi-dw-i26-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-i26-cwd-"));
  const prevKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "faux-dummy-key-not-used";
  const faux = registerFauxProvider({
    provider: "deepseek",
    models: [{ id: "faux-deepseek", name: "Faux DeepSeek", contextWindow: 128000, maxTokens: 4096 }],
  });
  try {
    await withFakeHomeAsync(home, () =>
      fn({
        cwd,
        model: faux.getModel(),
        setResponses: (msgs) => faux.setResponses(msgs as never),
        fauxAssistantMessage,
      }),
    );
  } finally {
    faux.unregister();
    if (prevKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevKey;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("a real subagent session that hits a usage limit surfaces PROVIDER_USAGE_LIMIT (not SCHEMA_NONCOMPLIANCE/EMPTY)", () =>
  withFauxSession(async ({ cwd, model, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT_MSG })]);
    const agent = new WorkflowAgent({ cwd, session: { model: model as never } });
    await assert.rejects(
      () => agent.run("do the task", { label: "probe" }),
      (err: unknown) => {
        const e = err as { code?: string; recoverable?: boolean; message?: string; resetHint?: string };
        assert.equal(e.code, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, `got ${e.code}`);
        assert.equal(e.recoverable, false, "must halt so the run can checkpoint, not retry-into-the-wall");
        assert.ok(e.message?.includes("usage limit reached"), "carries the real provider message");
        assert.equal(e.resetHint, "Resets in ~3h", "extracts the provider reset hint");
        return true;
      },
    );
  }));

test("a successful real turn whose text merely mentions 'rate limit' is NOT misclassified", () =>
  withFauxSession(async ({ cwd, model, setResponses, fauxAssistantMessage }) => {
    setResponses([fauxAssistantMessage("Done. I handled the rate limit gracefully.", { stopReason: "stop" })]);
    const agent = new WorkflowAgent({ cwd, session: { model: model as never } });
    const text = await agent.run("do the task", { label: "ok" });
    assert.ok(typeof text === "string" && text.includes("Done."), `expected normal text, got ${String(text)}`);
  }));

const TWO_AGENT_SCRIPT = `export const meta = { name: 'i26_integration', description: 'two agents' }
const a = await agent('first step', { label: 'first' })
const b = await agent('second step', { label: 'second' })
return { a, b }`;

function createManagerHarness({ cwd, model }: FauxSessionContext): {
  manager: WorkflowManager;
  pausedReasons: Array<string | undefined>;
} {
  const managerAgent = new WorkflowAgent({ cwd, session: { model: model as never } });
  const manager = new WorkflowManager({ cwd, agent: managerAgent });
  const pausedReasons: Array<string | undefined> = [];
  manager.on("paused", (e: { reason?: string }) => pausedReasons.push(e.reason));
  manager.on("error", () => {});
  return { manager, pausedReasons };
}

function stubUsageLimitPause({ setResponses, fauxAssistantMessage }: FauxSessionContext): void {
  // Agent 1 succeeds (journaled); agent 2 hits the usage limit.
  setResponses([
    fauxAssistantMessage("first-result-text", { stopReason: "stop" }),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: USAGE_LIMIT_MSG }),
  ]);
}

function stubSuccessfulResume({ setResponses, fauxAssistantMessage }: FauxSessionContext): void {
  // Budget refills: agent 2 now succeeds. Resume replays agent 1 from the journal.
  setResponses([fauxAssistantMessage("second-result-text", { stopReason: "stop" })]);
}

async function startPausedRun(manager: WorkflowManager): Promise<string> {
  const { runId, promise } = manager.startInBackground(TWO_AGENT_SCRIPT);
  await promise.catch(ignoreExpectedUsageLimit);
  return runId;
}

function ignoreExpectedUsageLimit(): void {}

function persistedRun(manager: WorkflowManager, runId: string): ReturnType<WorkflowManager["listRuns"]>[number] | undefined {
  return manager.listRuns().find((run) => run.runId === runId);
}

function assertPausedRunStatus(manager: WorkflowManager, runId: string): void {
  assert.equal(manager.getRun(runId)?.status, "paused", "run is checkpointed as paused, not failed");
}

function assertPersistedUsageLimit(manager: WorkflowManager, runId: string): void {
  const persisted = persistedRun(manager, runId);
  assert.equal(persisted?.pauseReason, "usage_limit");
  assert.equal(persisted?.resetHint, "Resets in ~3h");
}

function assertJournaledFirstResult(manager: WorkflowManager, runId: string): void {
  assert.ok((persistedRun(manager, runId)?.journal?.length ?? 0) >= 1, "agent 1's result is journaled");
}

function assertPausedEvent(pausedReasons: Array<string | undefined>): void {
  assert.ok(pausedReasons.includes("usage_limit"), "a usage_limit 'paused' event fired");
}

async function assertUsageLimitPause(
  manager: WorkflowManager,
  pausedReasons: Array<string | undefined>,
): Promise<string> {
  const runId = await startPausedRun(manager);
  assertPausedRunStatus(manager, runId);
  assertPersistedUsageLimit(manager, runId);
  assertJournaledFirstResult(manager, runId);
  assertPausedEvent(pausedReasons);
  return runId;
}

function resumedResult(manager: WorkflowManager, runId: string): { a?: string; b?: string } | undefined {
  return manager.getRun(runId)?.result?.result as { a?: string; b?: string } | undefined;
}

async function assertUsageLimitResume(manager: WorkflowManager, runId: string): Promise<void> {
  assert.equal(await manager.resume(runId), true, "the paused run is resumable");
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(manager.getRun(runId)?.status, "completed", "resumed run completes once the limit clears");
  assert.equal(resumedResult(manager, runId)?.a, "first-result-text", "agent 1 replayed from journal");
  assert.equal(resumedResult(manager, runId)?.b, "second-result-text", "agent 2 ran live after refill");
}

async function assertManagerPausesAndResumes(ctx: FauxSessionContext): Promise<void> {
  const { manager, pausedReasons } = createManagerHarness(ctx);
  stubUsageLimitPause(ctx);
  const runId = await assertUsageLimitPause(manager, pausedReasons);
  stubSuccessfulResume(ctx);
  await assertUsageLimitResume(manager, runId);
}

test("through the manager: a usage limit pauses the run (not fails) and resume replays the journal", () =>
  withFauxSession(assertManagerPausesAndResumes));
