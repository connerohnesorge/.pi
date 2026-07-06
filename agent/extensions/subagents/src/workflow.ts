import { createHash } from "node:crypto";
import vm from "node:vm";
import type { Node } from "acorn";
import { parse } from "acorn";
import type { TSchema } from "typebox";
import type { AgentUsage } from "./agent.ts";
import { WorkflowAgent, type WorkflowAgentOptions } from "./agent.ts";
import type { AgentHistoryEntry } from "./agent-history.ts";
import {
  type AgentDefinition,
  type AgentRegistry,
  agentDefinitionKey,
  loadAgentRegistry,
  resolveAgentType,
} from "./agent-registry.ts";
import { DEFAULT_AGENT_TIMEOUT_MS, MAX_AGENT_RETRIES, MAX_AGENTS_PER_RUN, MAX_CONCURRENCY } from "./config.ts";
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.ts";
import { createWorkflowLogger } from "./logger.ts";
import { parseModelRoutingFromMeta, resolveModelForPhase } from "./model-routing.ts";
import { createAgentStoreTools, SharedStore } from "./shared-store.ts";
import { createWorktree, removeWorktree, type Worktree } from "./worktree.ts";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowMetaPhase[];
  /** Default model for agents whose phase has no route and that set no model/tier. */
  model?: string;
}

/** One cached agent() result, keyed by its deterministic call index. */
export interface JournalEntry {
  index: number;
  /** sha256 of the call's identity (prompt + model + phase + agentType + schema). */
  hash: string;
  result: unknown;
  /**
   * Per-agent write delta (keys set by this agent) for additive replay on resume.
   * Replaces the former full-map snapshot to fix parallel-agent ordering: applying
   * deltas in callSeq order accumulates all agents' writes correctly regardless of
   * which agent finished first. Absent on older journal entries.
   */
  storeDelta?: Record<string, unknown>;
  /** Persisted Pi session file for reopening this workflow agent. */
  sessionFile?: string;
}

/**
 * Global resources shared across a run and any workflow() nested inside it, so
 * the 16-concurrent / 1000-total caps and the token budget hold across nesting
 * instead of each level getting its own limiter and counters.
 */
export interface SharedRuntime {
  limiter: <T>(fn: () => Promise<T>) => Promise<T>;
  agentCount: number;
  spent: number;
  tokenUsage: { input: number; output: number; total: number; cost: number; cacheRead: number; cacheWrite: number };
  depth: number;
}

export interface WorkflowRunOptions extends WorkflowAgentOptions {
  args?: unknown;
  agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), shown in /workflows for default agents. */
  mainModel?: string;
  /**
   * Named subagent definitions for `agent({ agentType })`. Snapshotted once per
   * run for determinism. Defaults to scanning `.pi/agents` (project) + `~/.pi/agents`.
   * Injectable for tests.
   */
  agentRegistry?: AgentRegistry;
  concurrency?: number;
  /** Retry attempts after a recoverable agent failure. Default 0. */
  agentRetries?: number;
  tokenBudget?: number | null;
  signal?: AbortSignal;
  /** Maximum number of agents allowed in this run. Default: 1000 */
  maxAgents?: number;
  /** Timeout per agent in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /** Directory where workflow subagent Pi sessions are persisted. */
  agentSessionDir?: string;
  /** Parent/originating Pi session file stamped onto each subagent session. */
  agentParentSessionFile?: string;
  /** Whether to persist logs to disk. Default: true */
  persistLogs?: boolean;
  /** Run ID for persistence. Auto-generated if not provided. */
  runId?: string;
  /** Resume: cached agent results keyed by deterministic call index. */
  resumeJournal?: Map<number, JournalEntry>;
  /** Resume: the run being resumed (informational; enables resume mode). */
  resumeFromRunId?: string;
  /** Called after each live agent completes so the caller can persist the journal. */
  onAgentJournal?: (entry: JournalEntry) => void;
  /** Internal: shared runtime inherited by a nested workflow() call. */
  sharedRuntime?: SharedRuntime;
  /**
   * Shared store for this run. One instance is created per top-level run and
   * propagated into nested workflow() calls. Pass an existing instance to share
   * state across a parent and child run; omit to create a fresh isolated store.
   */
  sharedStore?: SharedStore;
  /** Resolve a saved-workflow name to its script, enabling `workflow('name', args)`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /**
   * Ask the human a checkpoint() question and resolve to their reply. Threaded from
   * a UI-bearing tool context. Absent => headless: checkpoint() takes its declared
   * default (and journals it), so a detached/background run never hangs.
   */
  confirm?: (promptText: string, options: CheckpointOptions) => Promise<unknown>;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  onAgentStart?: (event: { label: string; phase?: string; prompt: string; model?: string }) => void;
  onAgentSession?: (event: { label: string; phase?: string; sessionFile?: string; sessionId?: string }) => void;
  onAgentEnd?: (event: {
    label: string;
    phase?: string;
    result: unknown;
    tokens?: number;
    worktree?: string;
    model?: string;
    sessionFile?: string;
    error?: string;
    errorCode?: WorkflowErrorCode;
    recoverable?: boolean;
  }) => void;
  onAgentHistory?: (event: { label: string; phase?: string; history: AgentHistoryEntry[] }) => void;
  onTokenUsage?: (usage: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  }) => void;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  runId?: string;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
  label?: string;
  phase?: string;
  schema?: TSchemaDef;
  /**
   * Run this agent on a specific model (`provider/modelId` or a bare `modelId`).
   * The workflow author chooses per-agent models per the routing policy in the
   * tool guidelines (e.g. a lighter model for exploration, the main model for
   * analysis). When omitted, the session's main model is used.
   */
  model?: string;
  /**
   * Coarse model tier ("small" | "medium" | "big"), resolved from the user's
   * model-tiers config (see /workflows-models). An explicit `model` takes
   * precedence; a tier takes precedence over the phase model. When the tier has
   * no configured entry it falls back to the session's main model.
   */
  tier?: string;
  isolation?: "worktree";
  /**
   * Name of a registered subagent definition (`.pi/agents/<name>.md`, project >
   * user). Binds that definition's tool allow/denylist, model, and body prompt
   * to this agent. An explicit `model` overrides the definition's model; the
   * definition's model overrides `tier`/phase. An unknown name logs a warning
   * and falls back to default tools/model (with the name as a prose hint).
   */
  agentType?: string;
  /** Override timeout for this specific agent. null means no hard timeout. */
  timeoutMs?: number | null;
  /** Retry attempts after a recoverable failure for this specific agent. */
  retries?: number;
}

/** Options for a human checkpoint() — a deterministic, journaled, replayable gate. */
export interface CheckpointOptions {
  /** Reply used when no UI is available (headless/background) and headless != "abort". */
  default?: unknown;
  /** Headless behavior: "default" (take `default`/true) or "abort" (throw). Default "default". */
  headless?: "default" | "abort";
  /** Confirm | free-text input | pick-one. Affects the hash and the UI widget. */
  kind?: "confirm" | "input" | "select";
  /** For kind "select". */
  choices?: string[];
  /** Per-checkpoint timeout in ms for the interactive prompt. */
  timeoutMs?: number;
}

interface RuntimeState {
  currentPhase?: string;
  /**
   * Per-phase soft sub-budgets carved from the run total: phase title -> the
   * ceiling and the run-wide spent at the moment the budget was declared. A phase
   * exceeding its ceiling throws TOKEN_BUDGET_EXHAUSTED while the run's overall
   * budget is untouched. Soft gate (like the global one): spent accrues after each
   * agent, so an in-flight wave may overshoot slightly.
   */
  phaseBudgets: Map<string, { budget: number; startSpent: number; warned: boolean }>;
  logs: string[];
  phases: string[];
  /** Monotonic, assigned at lexical agent() call time — the stable resume key. */
  callSeq: number;
  /**
   * Index of the first call that missed the resume journal (changed or new).
   * Longest-unchanged-prefix resume: a cached result is replayed only while
   * callIndex < firstMiss; once a call misses, it AND everything after run live.
   */
  firstMiss: number;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

// Parse-time author hint (fast feedback). The real enforcement is DETERMINISM_PRELUDE.
const DETERMINISM_BLOCKLIST = /\bDate\s*\.\s*now\b|\bMath\s*\.\s*random\b|\bnew\s+Date\s*\(\s*\)/;

/**
 * Runtime determinism hardening, run inside the vm realm BEFORE the user script.
 * It neuters the nondeterministic builtins that would break resume (they'd make a
 * re-run produce different values than the cached journal):
 *   - Math.random()        -> throws
 *   - Date.now()           -> throws
 *   - Date() / new Date()  -> throws (no-arg); new Date(arg) still works
 * Using the vm realm's own Math/Date/Reflect (not host objects) means this adds
 * no host-`Function` escape. Note: vm is not a security sandbox — an injected
 * bridge function's `.constructor` is still the host Function, so a determined
 * script could bypass this. The guard is best-effort against ACCIDENTAL
 * nondeterminism from trusted (user / guided-LLM) scripts, not a security wall.
 */
const DETERMINISM_PRELUDE = [
  '"use strict";',
  'Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (it breaks resume); pass randomness via args or vary by index"); };',
  "{",
  "  const RealDate = Date;",
  '  const fail = (w) => { throw new Error(w + " is unavailable in a workflow (it breaks resume); pass a timestamp via args"); };',
  "  const SafeDate = function (...a) {",
  '    if (!new.target) fail("Date()");',
  '    if (a.length === 0) fail("new Date()");',
  "    return Reflect.construct(RealDate, a, SafeDate);",
  "  };",
  "  SafeDate.UTC = RealDate.UTC;",
  "  SafeDate.parse = RealDate.parse;",
  '  SafeDate.now = () => fail("Date.now()");',
  "  SafeDate.prototype = RealDate.prototype;",
  "  globalThis.Date = SafeDate;",
  "}",
].join("\n");

export function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  return runWorkflowInternal(script, options);
}

function createWorkflowRuntimeSetup(meta: WorkflowMeta, options: WorkflowRunOptions, started: number) {
  const baseCwd = options.cwd ?? process.cwd();
  const shared = options.sharedRuntime ?? createSharedRuntime(workflowConcurrency(options));
  const runId = options.runId ?? `run-${started.toString(36)}`;

  return {
    routingConfig: parseModelRoutingFromMeta(meta.phases, meta.model),
    maxAgents: options.maxAgents ?? MAX_AGENTS_PER_RUN,
    agentTimeoutMs: workflowAgentTimeout(options),
    runId,
    baseCwd,
    agentRegistry: options.agentRegistry ?? loadAgentRegistry(baseCwd),
    logger: workflowLogger(options, runId, baseCwd),
    state: createRuntimeState(meta),
    agentRunner: options.agent ?? new WorkflowAgent(options),
    shared,
    store: options.sharedStore ?? new SharedStore(),
  };
}

function workflowConcurrency(options: WorkflowRunOptions): number {
  return normalizeConcurrency(options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2));
}

function workflowAgentTimeout(options: WorkflowRunOptions): number | null {
  return options.agentTimeoutMs !== undefined ? options.agentTimeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
}

function workflowLogger(options: WorkflowRunOptions, runId: string, cwd: string) {
  return createWorkflowLogger({
    runId,
    cwd,
    persist: options.persistLogs ?? true,
    onLog: options.onLog,
  });
}

function createRuntimeState(meta: WorkflowMeta): RuntimeState {
  const firstPhase = meta.phases?.[0]?.title;
  return {
    logs: [],
    phases: firstPhase ? [firstPhase] : [],
    currentPhase: firstPhase,
    phaseBudgets: new Map(),
    callSeq: 0,
    firstMiss: Number.POSITIVE_INFINITY,
  };
}

function createSharedRuntime(concurrency: number): SharedRuntime {
  return {
    limiter: createLimiter(concurrency),
    agentCount: 0,
    spent: 0,
    tokenUsage: { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
    depth: 0,
  };
}

async function runWorkflowInternal<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  const setup = createWorkflowRuntimeSetup(meta, options, started);
  const { routingConfig, maxAgents, agentTimeoutMs, runId, baseCwd, agentRegistry, logger, state, agentRunner, shared, store } = setup;

  const log = (message: string) => {
    const text = String(message);
    state.logs.push(text);
    logger.log(text);
  };

  const phase = (title: string, phaseOptions?: { budget?: number }) => {
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    // Carve a soft sub-budget from the run total for work done under this phase.
    // Re-declaring re-bases from the current spent (idempotent across resume: the
    // script re-runs phase() and the ceiling is recomputed from live spent).
    if (typeof phaseOptions?.budget === "number" && phaseOptions.budget > 0) {
      state.phaseBudgets.set(title, { budget: phaseOptions.budget, startSpent: shared.spent, warned: false });
    }
    options.onPhase?.(title);
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => shared.spent,
    remaining: () => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - shared.spent)),
  });

  const throwIfAborted = () => {
    if (options.signal?.aborted) {
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    }
  };

  const agent = createAgentFunction({
    options,
    maxAgents,
    agentTimeoutMs,
    budget,
    state,
    shared,
    log,
    logger,
    throwIfAborted,
    agentRegistry,
    routingConfig,
    runId,
    store,
    baseCwd,
    agentRunner,
  });

  const parallel = createParallelFunction({ options, log, throwIfAborted });
  const pipeline = createPipelineFunction({ options, log, throwIfAborted });

  const workflowFn = createNestedWorkflowFunction({ options, shared, store, runId, throwIfAborted });
  const { verify, judgePanel, loopUntilDry, completenessCheck, retry, gate } = createQualityStdlib(agent, parallel);

  // Deterministic, journaled, replayable human checkpoint. Spends no tokens, so it
  // is gated on the agent counter + abort (not budget). On resume the human's reply
  // replays by callIndex exactly like a cached agent() — the genuine edge over CC,
  // whose steering is in-session only. Headless (no UI threaded in): takes the
  // declared default and journals THAT, so a detached/background run never hangs.
  const checkpoint = createCheckpointFunction({ options, maxAgents, state, shared, throwIfAborted });

  const context = vm.createContext({
    agent,
    parallel,
    pipeline,
    workflow: workflowFn,
    verify,
    judgePanel,
    loopUntilDry,
    completenessCheck,
    retry,
    gate,
    checkpoint,
    log,
    phase,
    args: options.args,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget,
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
    // Object/Array/JSON/Math/Date/Promise/Set/Map/etc. come from the vm realm
    // itself — we deliberately do NOT inject host built-ins, whose .constructor
    // would be the host Function (a determinism-guard bypass). Math/Date are
    // neutered in-realm by DETERMINISM_PRELUDE below.
  });

  const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`;
  try {
    const result = await new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context);

    // Persist logs
    const logFile = logger.persist();
    if (logFile) {
      log(`Logs persisted to ${logFile}`);
    }

    // Emit final token usage
    options.onTokenUsage?.(shared.tokenUsage);

    return {
      meta,
      result: result as T,
      logs: state.logs,
      phases: state.phases,
      agentCount: shared.agentCount,
      durationMs: Date.now() - started,
      runId,
      tokenUsage: shared.tokenUsage,
    };
  } finally {
    // Dispose the store only when this run created it; nested runs inherit the
    // parent's store and must not tear it down while the parent is still running.
    if (!options.sharedStore) store.dispose();
  }
}

type WorkflowAgentCall = (prompt: string, agentOptions?: AgentOptions) => Promise<unknown>;

interface NestedWorkflowContext {
  options: WorkflowRunOptions;
  shared: SharedRuntime;
  store: SharedStore;
  runId: string;
  throwIfAborted: () => void;
}

function createNestedWorkflowFunction(ctx: NestedWorkflowContext) {
  return async function nestedWorkflow(nameOrScript: string, childArgs?: unknown) {
    ctx.throwIfAborted();
    if (ctx.shared.depth >= 1) {
      throw new WorkflowError("workflow() can nest only one level deep", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
      });
    }
    const resolved = ctx.options.loadSavedWorkflow?.(String(nameOrScript));
    const childScript = resolved ?? String(nameOrScript);
    ctx.shared.depth++;
    try {
      const child = await runWorkflow(childScript, {
        ...ctx.options,
        args: childArgs,
        sharedRuntime: ctx.shared,
        sharedStore: ctx.store,
        resumeJournal: undefined,
        resumeFromRunId: undefined,
        runId: `${ctx.runId}-nested${ctx.shared.depth}`,
        persistLogs: false,
      });
      return child.result;
    } finally {
      ctx.shared.depth--;
    }
  };
}

function createQualityStdlib(agent: WorkflowAgentCall, parallel: WorkflowParallel) {
  const VERIFY_SCHEMA = {
    type: "object",
    properties: { real: { type: "boolean" }, reason: { type: "string" } },
    required: ["real"],
  };
  const JUDGE_SCHEMA = {
    type: "object",
    properties: { score: { type: "number" }, reason: { type: "string" } },
    required: ["score"],
  };
  const COMPLETENESS_SCHEMA = {
    type: "object",
    properties: { complete: { type: "boolean" }, missing: { type: "array", items: { type: "string" } } },
    required: ["complete"],
  };

  return {
    verify: (item: unknown, opts: { reviewers?: number; threshold?: number; lens?: string | string[] } = {}) =>
      verifyItem(item, opts, agent, parallel, VERIFY_SCHEMA),
    judgePanel: (attempts: unknown[], opts: { judges?: number; rubric?: string } = {}) =>
      judgeAttempts(attempts, opts, agent, parallel, JUDGE_SCHEMA),
    loopUntilDry: (opts: LoopUntilDryOptions) => collectUntilDry(opts),
    completenessCheck: (taskArgs: unknown, results: unknown) =>
      agent(
        `Given the task and the results gathered so far, list what is still MISSING (modalities not covered, claims unverified, gaps). Be specific and concise.\n\nTask:\n${JSON.stringify(taskArgs)}\n\nResults so far:\n${JSON.stringify(results).slice(0, 4000)}`,
        { label: "completeness critic", tier: "big", schema: COMPLETENESS_SCHEMA },
      ),
    retry: retryWorkflowThunk,
    gate: gateWorkflowThunk,
  };
}

async function verifyItem(
  item: unknown,
  opts: { reviewers?: number; threshold?: number; lens?: string | string[] },
  agent: WorkflowAgentCall,
  parallel: WorkflowParallel,
  schema: TSchema,
) {
  const reviewers = Math.max(1, opts.reviewers ?? 2);
  const threshold = opts.threshold ?? 0.5;
  const lenses = opts.lens ? (Array.isArray(opts.lens) ? opts.lens : [opts.lens]) : [];
  const claim = typeof item === "string" ? item : JSON.stringify(item);
  const votes = (await parallel(makeVerifyReviewers(reviewers, lenses, claim, agent, schema))).filter(Boolean) as Array<{
    real?: boolean;
    reason?: string;
  }>;
  const realCount = votes.filter((v) => v?.real).length;
  return { real: votes.length > 0 && realCount / votes.length >= threshold, realCount, total: votes.length, votes };
}

function makeVerifyReviewers(
  reviewers: number,
  lenses: string[],
  claim: string,
  agent: WorkflowAgentCall,
  schema: TSchema,
) {
  return Array.from({ length: reviewers }, function makeVerifyReviewer(_v, i) {
    return () =>
      agent(
        `Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.${lenses.length ? ` Focus lens: ${lenses[i % lenses.length]}.` : ""}\n\n${claim}`,
        { label: `verify ${i + 1}`, tier: "medium", schema },
      );
  });
}

async function judgeAttempts(
  attempts: unknown[],
  opts: { judges?: number; rubric?: string },
  agent: WorkflowAgentCall,
  parallel: WorkflowParallel,
  schema: TSchema,
) {
  const judges = Math.max(1, opts.judges ?? 3);
  const rubric = opts.rubric ?? "overall quality and correctness";
  const scored = (await parallel(makeJudgeAttemptTasks(attempts, judges, rubric, agent, parallel, schema))).filter(Boolean) as Array<{
    index: number;
    attempt: unknown;
    score: number;
    judgments: unknown[];
  }>;
  return bestJudgedAttempt(scored);
}

function makeJudgeAttemptTasks(
  attempts: unknown[],
  judges: number,
  rubric: string,
  agent: WorkflowAgentCall,
  parallel: WorkflowParallel,
  schema: TSchema,
) {
  return (Array.isArray(attempts) ? attempts : []).map(function makeJudgeAttemptTask(att, idx) {
    return () => scoreAttempt(att, idx, judges, rubric, agent, parallel, schema);
  });
}

async function scoreAttempt(
  attempt: unknown,
  index: number,
  judges: number,
  rubric: string,
  agent: WorkflowAgentCall,
  parallel: WorkflowParallel,
  schema: TSchema,
) {
  const text = typeof attempt === "string" ? attempt : JSON.stringify(attempt);
  const judgments = (await parallel(makeJudgeTasks(index, judges, rubric, text, agent, schema))).filter(Boolean) as Array<{
    score?: number;
  }>;
  const score = judgments.length ? judgments.reduce((sum, judgment) => sum + (Number(judgment?.score) || 0), 0) / judgments.length : 0;
  return { index, attempt, score, judgments };
}

function makeJudgeTasks(
  attemptIndex: number,
  judges: number,
  rubric: string,
  text: string,
  agent: WorkflowAgentCall,
  schema: TSchema,
) {
  return Array.from({ length: judges }, function makeJudgeTask(_v, judgeIndex) {
    return () =>
      agent(`Score this candidate from 0 to 1 on: ${rubric}. Reply with the score.\n\nCandidate:\n${text}`, {
        label: `judge ${attemptIndex + 1}.${judgeIndex + 1}`,
        tier: "medium",
        schema,
      });
  });
}

function bestJudgedAttempt(scored: Array<{ index: number; attempt: unknown; score: number; judgments: unknown[] }>) {
  let best = scored[0];
  for (const score of scored) {
    if (score.score > best.score || (score.score === best.score && score.index < best.index)) best = score;
  }
  return best;
}

async function retryWorkflowThunk(
  thunk: (attempt: number) => Promise<unknown> | unknown,
  opts: { attempts?: number; until?: (r: unknown) => boolean } = {},
) {
  const attempts = Math.max(1, opts.attempts ?? 3);
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    last = await thunk(i);
    if (!opts.until || opts.until(last)) return last;
  }
  return last;
}

async function gateWorkflowThunk(
  thunk: (feedback: string | undefined, attempt: number) => Promise<unknown> | unknown,
  validator: (r: unknown) => Promise<{ ok: boolean; feedback?: string }> | { ok: boolean; feedback?: string },
  opts: { attempts?: number } = {},
) {
  const attempts = Math.max(1, opts.attempts ?? 3);
  let feedback: string | undefined;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    last = await thunk(feedback, i);
    const verdict = await validator(last);
    if (verdict?.ok) return { ok: true, value: last, attempts: i + 1 };
    feedback = verdict?.feedback;
  }
  return { ok: false, value: last, attempts };
}


interface WorkflowCombinatorContext {
  options: WorkflowRunOptions;
  log: (message: string) => void;
  throwIfAborted: () => void;
}

type WorkflowParallel = (thunks: Array<() => Promise<unknown>>) => Promise<unknown[]>;
type WorkflowPipeline = (
  items: unknown[],
  ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
) => Promise<unknown[]>;

function createParallelFunction(ctx: WorkflowCombinatorContext): WorkflowParallel {
  return async function workflowParallel(thunks: Array<() => Promise<unknown>>) {
    ctx.throwIfAborted();
    if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
    }
    return Promise.all(thunks.map((thunk, index) => runParallelThunk(thunk, index, ctx)));
  };
}

async function runParallelThunk(thunk: () => Promise<unknown>, index: number, ctx: WorkflowCombinatorContext) {
  try {
    return await thunk();
  } catch (error) {
    if (ctx.options.signal?.aborted) throw error;
    const workflowError = wrapError(error);
    if (!workflowError.recoverable) throw workflowError;
    ctx.log(`parallel[${index}] failed: ${workflowError.message}`);
    return null;
  }
}

function createPipelineFunction(ctx: WorkflowCombinatorContext): WorkflowPipeline {
  return async function workflowPipeline(
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ) {
    ctx.throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    return Promise.all(items.map((item, index) => runPipelineItem(item, index, stages, ctx)));
  };
}

async function runPipelineItem(
  item: unknown,
  index: number,
  stages: Array<(prev: unknown, original: unknown, index: number) => unknown>,
  ctx: WorkflowCombinatorContext,
) {
  let value: unknown = item;
  for (const stage of stages) {
    try {
      ctx.throwIfAborted();
      value = await stage(value, item, index);
      ctx.throwIfAborted();
    } catch (error) {
      if (ctx.options.signal?.aborted) throw error;
      const workflowError = wrapError(error);
      if (!workflowError.recoverable) throw workflowError;
      ctx.log(`pipeline[${index}] failed: ${workflowError.message}`);
      return null;
    }
  }
  return value;
}


interface LoopUntilDryOptions {
  round: (roundIndex: number) => Promise<unknown[]> | unknown[];
  key?: (item: unknown) => string;
  consecutiveEmpty?: number;
  maxRounds?: number;
}

async function collectUntilDry(opts: LoopUntilDryOptions) {
  assertLoopUntilDryOptions(opts);
  const key = opts.key ?? ((x: unknown) => JSON.stringify(x));
  const state = createDrynessState();
  const consecutiveEmpty = Math.max(1, opts.consecutiveEmpty ?? 2);
  const maxRounds = opts.maxRounds ?? 50;

  while (shouldRunDrynessRound(state.round, maxRounds, state.dry, consecutiveEmpty)) {
    const items = await runDrynessRound(opts.round, state.round);
    if (items === null) break;
    applyDrynessRound(state, items, key);
  }
  return state.all;
}

function assertLoopUntilDryOptions(opts: LoopUntilDryOptions) {
  if (!opts || typeof opts.round !== "function") throw new TypeError("loopUntilDry requires { round: (i) => items[] }");
}

function createDrynessState() {
  return { seen: new Set<string>(), all: [] as unknown[], round: 0, dry: 0 };
}

function shouldRunDrynessRound(round: number, maxRounds: number, dry: number, consecutiveEmpty: number) {
  return round < maxRounds && dry < consecutiveEmpty;
}

function applyDrynessRound(state: ReturnType<typeof createDrynessState>, items: unknown[], key: (item: unknown) => string) {
  const fresh = filterFreshItems(items, state.seen, key);
  state.round++;
  if (!fresh.length) {
    state.dry++;
    return;
  }
  state.dry = 0;
  rememberFreshItems(fresh, state.seen, key, state.all);
}

async function runDrynessRound(round: LoopUntilDryOptions["round"], roundIndex: number): Promise<unknown[] | null> {
  try {
    return (await round(roundIndex)) ?? [];
  } catch (error) {
    if (isLoopBudgetExhaustion(error)) return null;
    throw error;
  }
}

function isLoopBudgetExhaustion(error: unknown) {
  const code = (error as { code?: string })?.code;
  return code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED || code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED;
}

function filterFreshItems(items: unknown[], seen: Set<string>, key: (item: unknown) => string) {
  return (Array.isArray(items) ? items : []).filter((x) => x != null && !seen.has(key(x)));
}

function rememberFreshItems(
  fresh: unknown[],
  seen: Set<string>,
  key: (item: unknown) => string,
  all: unknown[],
) {
  for (const x of fresh) {
    seen.add(key(x));
    all.push(x);
  }
}


interface CheckpointFunctionContext {
  options: WorkflowRunOptions;
  maxAgents: number;
  state: RuntimeState;
  shared: SharedRuntime;
  throwIfAborted: () => void;
}

function createCheckpointFunction(ctx: CheckpointFunctionContext) {
  return async function workflowCheckpoint(promptText: string, checkpointOptions: CheckpointOptions = {}) {
    ctx.throwIfAborted();
    assertCheckpointCanStart(ctx, promptText);

    const callIndex = ctx.state.callSeq++;
    const callHash = hashCheckpoint(promptText, checkpointOptions);
    const cached = checkpointCacheHit(ctx, callIndex, callHash);
    ctx.shared.agentCount++;
    if (cached) return cached.result;

    const reply = await resolveCheckpointReply(promptText, checkpointOptions, ctx.options);
    ctx.throwIfAborted();
    ctx.options.onAgentJournal?.({ index: callIndex, hash: callHash, result: reply });
    return reply;
  };
}

function assertCheckpointCanStart(ctx: CheckpointFunctionContext, promptText: string) {
  if (typeof promptText !== "string") throw new TypeError("checkpoint(promptText, options?) needs a prompt string");
  if (ctx.shared.agentCount < ctx.maxAgents) return;
  throw new WorkflowError(
    `Agent limit exceeded (${ctx.maxAgents}). Use maxAgents option to increase the limit.`,
    WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
    { recoverable: false },
  );
}

function checkpointCacheHit(
  ctx: CheckpointFunctionContext,
  callIndex: number,
  callHash: string,
): JournalEntry | undefined {
  const cached = ctx.options.resumeJournal?.get(callIndex);
  if (cached != null && cached.hash === callHash && callIndex < ctx.state.firstMiss) return cached;
  if (cached == null || cached.hash !== callHash) ctx.state.firstMiss = Math.min(ctx.state.firstMiss, callIndex);
  return undefined;
}

async function resolveCheckpointReply(
  promptText: string,
  checkpointOptions: CheckpointOptions,
  options: WorkflowRunOptions,
): Promise<unknown> {
  if (options.confirm) return options.confirm(promptText, checkpointOptions);
  if (checkpointOptions.headless === "abort") {
    throw new WorkflowError(
      `checkpoint "${promptText}" needs human input but none is available (headless run)`,
      WorkflowErrorCode.WORKFLOW_ABORTED,
      { recoverable: false },
    );
  }
  return checkpointOptions.default ?? true;
}


interface WorkflowBudgetView {
  total: number | null;
  spent: () => number;
  remaining: () => number;
}

interface AgentFunctionContext {
  options: WorkflowRunOptions;
  maxAgents: number;
  agentTimeoutMs: number | null;
  budget: WorkflowBudgetView;
  state: RuntimeState;
  shared: SharedRuntime;
  log: (message: string) => void;
  logger: Pick<ReturnType<typeof createWorkflowLogger>, "error">;
  throwIfAborted: () => void;
  agentRegistry: AgentRegistry;
  routingConfig: ReturnType<typeof parseModelRoutingFromMeta>;
  runId: string;
  store: SharedStore;
  baseCwd: string;
  agentRunner: Pick<WorkflowAgent, "run">;
}

interface LiveAgentCallContext extends AgentFunctionContext {
  prompt: string;
  agentOptions: AgentOptions;
  assignedPhase: string | undefined;
  agentDef: AgentDefinition | undefined;
  modelSpec: string | undefined;
  displayModel: string | undefined;
  callIndex: number;
  callHash: string;
  deltaKey: string;
  label: string;
}

type AgentCallPlan = Pick<
  LiveAgentCallContext,
  "assignedPhase" | "agentDef" | "modelSpec" | "displayModel" | "callIndex" | "callHash" | "deltaKey" | "label"
>;

function createAgentFunction(ctx: AgentFunctionContext) {
  return async function workflowAgentCall(prompt: string, agentOptions: AgentOptions = {}) {
    ctx.throwIfAborted();
    assertAgentMayStart(ctx.shared, ctx.maxAgents, ctx.budget);

    const plan = prepareAgentCall(ctx, prompt, agentOptions);
    const cachedResult = replayCachedAgentResult({ ...ctx, ...plan, prompt, agentOptions });
    if (cachedResult.replayed) return cachedResult.result;

    return ctx.shared.limiter(() => runLiveAgentCall({ ...ctx, ...plan, prompt, agentOptions }));
  };
}

function prepareAgentCall(ctx: AgentFunctionContext, prompt: string, agentOptions: AgentOptions): AgentCallPlan {
  const assignedPhase = agentOptions.phase ?? ctx.state.currentPhase;
  enforcePhaseBudget(assignedPhase, ctx.state, ctx.shared, ctx.log);

  const agentDef = resolveAgentType(agentOptions.agentType, ctx.agentRegistry);
  if (agentOptions.agentType && !agentDef) ctx.log(`unknown agentType "${agentOptions.agentType}"; using default tools/model`);

  const modelSpec = resolveAgentModel(agentOptions, agentDef, assignedPhase, ctx.routingConfig);
  const callIndex = ctx.state.callSeq++;
  const callHash = hashAgentCall(prompt, modelSpec, assignedPhase, agentOptions, agentDefinitionKey(agentDef));

  ctx.shared.agentCount++;
  return {
    assignedPhase,
    agentDef,
    modelSpec,
    displayModel: modelSpec ?? ctx.options.mainModel,
    callIndex,
    callHash,
    deltaKey: `${ctx.runId}:${callIndex}`,
    label: agentOptions.label?.trim() || defaultAgentLabel(assignedPhase, ctx.shared.agentCount),
  };
}

function resolveAgentModel(
  agentOptions: AgentOptions,
  agentDef: AgentDefinition | undefined,
  assignedPhase: string | undefined,
  routingConfig: ReturnType<typeof parseModelRoutingFromMeta>,
): string | undefined {
  return agentOptions.model ?? agentDef?.model ?? (agentOptions.tier ? undefined : resolveModelForPhase(assignedPhase, routingConfig));
}

function assertAgentMayStart(shared: SharedRuntime, maxAgents: number, budget: WorkflowBudgetView) {
  if (shared.agentCount >= maxAgents) {
    throw new WorkflowError(
      `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
      WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
      { recoverable: false },
    );
  }

  if (budget.total !== null && budget.remaining() <= 0) {
    throw new WorkflowError("workflow token budget exhausted", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, {
      recoverable: false,
    });
  }
}

function enforcePhaseBudget(
  assignedPhase: string | undefined,
  state: RuntimeState,
  shared: SharedRuntime,
  log: (message: string) => void,
) {
  if (!assignedPhase) return;
  const pb = state.phaseBudgets.get(assignedPhase);
  if (!pb) return;

  const phaseSpent = shared.spent - pb.startSpent;
  if (phaseSpent >= pb.budget) {
    throw new WorkflowError(
      `phase "${assignedPhase}" token sub-budget exhausted (${pb.budget})`,
      WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
      { recoverable: false },
    );
  }
  if (!pb.warned && phaseSpent >= pb.budget * 0.8) {
    pb.warned = true;
    log(`phase "${assignedPhase}" at ${Math.round((phaseSpent / pb.budget) * 100)}% of its token sub-budget`);
  }
}

function replayCachedAgentResult(args: {
  options: WorkflowRunOptions;
  state: RuntimeState;
  store: SharedStore;
  prompt: string;
  agentOptions: AgentOptions;
  assignedPhase: string | undefined;
  displayModel: string | undefined;
  label: string;
  callIndex: number;
  callHash: string;
}): { replayed: true; result: unknown } | { replayed: false } {
  const cache = readReplayCache(args);
  if (canReplayCacheHit(cache, args.callIndex, args.state.firstMiss)) return replayCacheHit(args, cache.cached);
  noteReplayCacheMiss(args.state, args.callIndex, cache);
  return { replayed: false };
}

function readReplayCache(args: {
  options: WorkflowRunOptions;
  agentOptions: AgentOptions;
  callIndex: number;
  callHash: string;
}) {
  const cached = args.options.resumeJournal?.get(args.callIndex);
  const hashMatches = cached != null && cached.hash === args.callHash;
  return {
    cached,
    hashMatches,
    cachedEmptyOutput: hashMatches && isEmptyTextAgentResult(cached.result, args.agentOptions.schema),
  };
}

function canReplayCacheHit(
  cache: ReturnType<typeof readReplayCache>,
  callIndex: number,
  firstMiss: number,
): cache is ReturnType<typeof readReplayCache> & { cached: JournalEntry } {
  return cache.hashMatches && !cache.cachedEmptyOutput && callIndex < firstMiss;
}

function replayCacheHit(
  args: {
    options: WorkflowRunOptions;
    store: SharedStore;
    prompt: string;
    assignedPhase: string | undefined;
    displayModel: string | undefined;
    label: string;
  },
  cached: JournalEntry,
): { replayed: true; result: unknown } {
  args.options.onAgentStart?.({ label: args.label, phase: args.assignedPhase, prompt: args.prompt, model: args.displayModel });
  args.options.onAgentEnd?.({
    label: args.label,
    phase: args.assignedPhase,
    result: cached.result,
    tokens: 0,
    model: args.displayModel,
    sessionFile: cached.sessionFile,
  });
  if (cached.storeDelta) args.store.applyDelta(cached.storeDelta);
  return { replayed: true, result: cached.result };
}

function noteReplayCacheMiss(state: RuntimeState, callIndex: number, cache: ReturnType<typeof readReplayCache>) {
  if (!cache.hashMatches || cache.cachedEmptyOutput) state.firstMiss = Math.min(state.firstMiss, callIndex);
}

async function runLiveAgentCall(call: LiveAgentCallContext): Promise<unknown> {
  const retryAttempts = normalizeAgentRetries(call.agentOptions.retries ?? call.options.agentRetries ?? 0);
  const maxAttempts = retryAttempts + 1;
  const run = await prepareLiveAgentRun(call);
  const recordTokens = createTokenRecorder(call, run);

  call.options.onAgentStart?.({ label: call.label, phase: call.assignedPhase, prompt: call.prompt, model: run.displayModel });

  try {
    return await runAgentWithRetries(call, run, maxAttempts, recordTokens);
  } finally {
    if (run.worktree?.isolated) await removeWorktree(run.worktree);
  }
}

interface LiveAgentRunState {
  timeout: number | null;
  resolvedIsolation: "worktree" | undefined;
  worktree: Worktree | undefined;
  runCwd: string | undefined;
  usage: AgentUsage | undefined;
  displayModel: string | undefined;
  sessionFile: string | undefined;
}

async function prepareLiveAgentRun(call: LiveAgentCallContext): Promise<LiveAgentRunState> {
  const resolvedIsolation = call.agentOptions.isolation ?? call.agentDef?.isolation;
  const worktree = await prepareAgentWorktree(call, resolvedIsolation);
  return {
    timeout: call.agentOptions.timeoutMs !== undefined ? call.agentOptions.timeoutMs : call.agentTimeoutMs,
    resolvedIsolation,
    worktree,
    runCwd: worktree?.isolated ? worktree.cwd : undefined,
    usage: undefined,
    displayModel: call.displayModel,
    sessionFile: undefined,
  };
}

async function prepareAgentWorktree(call: LiveAgentCallContext, isolation: "worktree" | undefined): Promise<Worktree | undefined> {
  if (isolation !== "worktree") return undefined;
  const worktree = await createWorktree(call.baseCwd, `${call.runId}-${call.callIndex}-${call.label}`);
  if (!worktree.isolated) call.log(`isolation ignored for "${call.label}" (${worktree.reason})`);
  return worktree;
}

function createTokenRecorder(call: LiveAgentCallContext, run: LiveAgentRunState) {
  return (result: unknown): number => {
    const tokens = run.usage && run.usage.total > 0 ? run.usage.total : estimateTokens(result) + estimateTokens(call.prompt);
    if (run.usage) addTokenUsage(call.shared, run.usage);
    call.shared.tokenUsage.total += tokens;
    call.shared.spent += tokens;
    return tokens;
  };
}

function addTokenUsage(shared: SharedRuntime, usage: AgentUsage) {
  shared.tokenUsage.input += usage.input;
  shared.tokenUsage.output += usage.output;
  shared.tokenUsage.cost += usage.cost;
  shared.tokenUsage.cacheRead += usage.cacheRead;
  shared.tokenUsage.cacheWrite += usage.cacheWrite;
}

async function runAgentWithRetries(
  call: LiveAgentCallContext,
  run: LiveAgentRunState,
  maxAttempts: number,
  recordTokens: (result: unknown) => number,
): Promise<unknown> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    run.usage = undefined;
    try {
      const result = await runAgentAttempt(call, run);
      recordAgentSuccess(call, run, result, recordTokens(result));
      return result;
    } catch (error) {
      const handled = handleAgentAttemptError(call, run, error, attempt, maxAttempts, recordTokens);
      if (handled === "retry") continue;
      if (handled === "null") return null;
      throw handled;
    }
  }
  return null;
}

async function runAgentAttempt(call: LiveAgentCallContext, run: LiveAgentRunState): Promise<unknown> {
  call.throwIfAborted();
  const result = await withTimeout(
    call.agentRunner.run(call.prompt, {
      label: call.label,
      schema: call.agentOptions.schema,
      signal: call.options.signal,
      instructions: buildAgentInstructions(call.assignedPhase, call.agentOptions, call.agentDef, run.resolvedIsolation),
      model: call.modelSpec,
      tier: call.agentOptions.tier,
      modelRegistry: call.options.modelRegistry,
      sessionDir: call.options.agentSessionDir,
      parentSessionFile: call.options.agentParentSessionFile,
      toolNames: call.agentDef?.tools,
      disallowedToolNames: call.agentDef?.disallowedTools,
      systemTools: createAgentStoreTools(call.store, call.deltaKey),
      cwd: run.runCwd,
      onModelResolved: (id: string) => {
        run.displayModel = id;
      },
      onModelFallback: (spec: string) => {
        call.log(`${call.label}: model "${spec}" unavailable — using the session default`);
      },
      onUsage: (u: AgentUsage) => {
        run.usage = u;
      },
      onHistory: (history: AgentHistoryEntry[]) => {
        call.options.onAgentHistory?.({ label: call.label, phase: call.assignedPhase, history });
      },
      onSession: (session) => {
        run.sessionFile = session.sessionFile;
        call.options.onAgentSession?.({ label: call.label, phase: call.assignedPhase, ...session });
      },
    }),
    run.timeout,
    call.label,
  );

  call.throwIfAborted();
  if (isEmptyTextAgentResult(result, call.agentOptions.schema)) throw emptyAgentOutputError(call.label);
  return result;
}

function emptyAgentOutputError(label: string): WorkflowError {
  return new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
    recoverable: true,
    agentLabel: label,
  });
}

function recordAgentSuccess(call: LiveAgentCallContext, run: LiveAgentRunState, result: unknown, tokens: number) {
  call.options.onAgentJournal?.({
    index: call.callIndex,
    hash: call.callHash,
    result,
    storeDelta: call.store.commitDelta(call.deltaKey),
    sessionFile: run.sessionFile,
  });
  call.options.onAgentEnd?.({
    label: call.label,
    phase: call.assignedPhase,
    result,
    tokens,
    worktree: run.runCwd,
    model: run.displayModel,
    sessionFile: run.sessionFile,
  });
}

function handleAgentAttemptError(
  call: LiveAgentCallContext,
  run: LiveAgentRunState,
  error: unknown,
  attempt: number,
  maxAttempts: number,
  recordTokens: (result: unknown) => number,
): "retry" | "null" | WorkflowError {
  if (call.options.signal?.aborted) throw error;

  const workflowError = wrapError(error, { agentLabel: call.label });
  call.logger.error(`agent ${call.label} attempt ${attempt}/${maxAttempts} failed: ${workflowError.message}`);
  const tokens = recordTokens(null);

  if (workflowError.recoverable && attempt < maxAttempts) {
    call.log(`agent "${call.label}" attempt ${attempt}/${maxAttempts} failed: ${workflowError.code} ${workflowError.message}; retrying`);
    return "retry";
  }

  recordAgentFailure(call, run, workflowError, tokens);
  if (!workflowError.recoverable) return workflowError;

  call.log(
    `agent "${call.label}" exhausted ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${workflowError.code} ${workflowError.message}`,
  );
  return "null";
}

function recordAgentFailure(call: LiveAgentCallContext, run: LiveAgentRunState, error: WorkflowError, tokens: number) {
  call.options.onAgentEnd?.({
    label: call.label,
    phase: call.assignedPhase,
    result: null,
    tokens,
    worktree: run.runCwd,
    model: run.displayModel,
    sessionFile: run.sessionFile,
    error: error.message,
    errorCode: error.code,
    recoverable: error.recoverable,
  });
}



export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  rejectNondeterministicScript(script);

  const first = firstWorkflowStatement(script);
  const declarator = metaDeclarator(first);
  const meta = evaluateLiteral(requireMetaInit(declarator), "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

function rejectNondeterministicScript(script: string) {
  if (!DETERMINISM_BLOCKLIST.test(script)) return;
  throw new WorkflowError(
    "Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable",
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false },
  );
}

function firstWorkflowStatement(script: string): AnyNode {
  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type === "ExportNamedDeclaration") return first;
  throw new WorkflowError(
    "`export const meta = { name, description, phases }` must be the first statement in the script",
    WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
    { recoverable: false },
  );
}

function metaDeclarator(first: AnyNode): AnyNode {
  const declaration = first.declaration as AnyNode | null;
  assertMetaConstDeclaration(declaration);
  assertSingleMetaDeclaration(declaration);

  const declarator = declaration.declarations[0] as AnyNode;
  assertMetaName(declarator);
  return declarator;
}

function assertMetaConstDeclaration(declaration: AnyNode | null): asserts declaration is AnyNode {
  if (declaration?.type === "VariableDeclaration" && declaration.kind === "const") return;
  throw new WorkflowError("meta export must be `export const meta = ...`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
    recoverable: false,
  });
}

function assertSingleMetaDeclaration(declaration: AnyNode) {
  if (declaration.declarations.length === 1) return;
  throw new WorkflowError("meta export must declare only `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
    recoverable: false,
  });
}

function assertMetaName(declarator: AnyNode) {
  if (declarator.id?.type === "Identifier" && declarator.id.name === "meta") return;
  throw new WorkflowError("meta export must declare `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
    recoverable: false,
  });
}

function requireMetaInit(declarator: AnyNode): AnyNode {
  if (declarator.init) return declarator.init;
  throw new WorkflowError("meta must have a literal value", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
    recoverable: false,
  });
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  if (node.type === "ObjectExpression") return evaluateLiteralObject(node, path);
  if (node.type === "ArrayExpression") return evaluateLiteralArray(node, path);
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral") return evaluateStaticTemplate(node, path);
  if (node.type === "UnaryExpression") return evaluateLiteralUnary(node, path);
  throw new Error(`non-literal node type in ${path}: ${node.type}`);
}

function evaluateLiteralObject(node: AnyNode, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const prop of node.properties as AnyNode[]) {
    const key = literalPropertyKey(prop, path);
    out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
  }
  return out;
}

function literalPropertyKey(prop: AnyNode, path: string): string {
  assertPlainLiteralProperty(prop, path);
  const key = propertyKey(prop.key as AnyNode, path);
  if (RESERVED_LITERAL_KEYS.has(key)) throw new Error(`reserved key name not allowed in ${path}: ${key}`);
  return key;
}

const RESERVED_LITERAL_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertPlainLiteralProperty(prop: AnyNode, path: string): asserts prop is AnyNode {
  if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
  if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
  if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
  if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
}

function evaluateLiteralArray(node: AnyNode, path: string): unknown[] {
  return (node.elements as Array<AnyNode | null>).map((element, index) => {
    if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
    if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
    return evaluateLiteral(element, `${path}[${index}]`);
  });
}

function evaluateStaticTemplate(node: AnyNode, path: string): string {
  if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
  return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
}

function evaluateLiteralUnary(node: AnyNode, path: string): unknown {
  if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
    return -node.argument.value;
  }
  throw new Error(`only negative-number unary allowed in ${path}`);
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) {
    return String(node.value);
  }
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  const value = requireMetaObject(meta);
  requireNonEmptyString(value.name, "meta.name");
  requireNonEmptyString(value.description, "meta.description");
  validateOptionalString(value.model, "meta.model");
  validateMetaPhases(value.phases);
}

function requireMetaObject(meta: unknown): WorkflowMeta {
  if (meta && typeof meta === "object") return meta as WorkflowMeta;
  throw new Error("meta must be an object");
}

function requireNonEmptyString(value: unknown, field: string) {
  if (typeof value === "string" && value.trim()) return;
  throw new Error(`${field} must be a non-empty string`);
}

function validateOptionalString(value: unknown, field: string) {
  if (value === undefined || typeof value === "string") return;
  throw new Error(`${field} must be a string`);
}

function validateMetaPhases(phases: WorkflowMeta["phases"]) {
  if (phases === undefined) return;
  if (!Array.isArray(phases)) throw new Error("meta.phases must be an array");
  for (const phase of phases) validateMetaPhase(phase);
}

function validateMetaPhase(phase: unknown) {
  if (phase && typeof phase === "object" && typeof (phase as WorkflowMetaPhase).title === "string") return;
  throw new Error("each meta phase must have a title string");
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

/** Stable identity hash for an agent() call — a cache miss on resume when anything changes. */
function hashCheckpoint(promptText: string, options: CheckpointOptions): string {
  const identity = JSON.stringify({
    promptText,
    kind: options.kind ?? "confirm",
    choices: options.choices ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

function hashAgentCall(
  prompt: string,
  model: string | undefined,
  phase: string | undefined,
  options: AgentOptions,
  agentDefKey: string | null,
): string {
  const identity = JSON.stringify({
    prompt,
    model: model ?? null,
    tier: options.tier ?? null,
    phase: phase ?? null,
    agentType: options.agentType ?? null,
    // Resolved definition (tools/model/prompt) so editing an agent .md invalidates
    // this call's cached result on a later resume.
    agentDef: agentDefKey,
    schema: options.schema ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

function buildAgentInstructions(
  phase: string | undefined,
  options: AgentOptions,
  def: AgentDefinition | undefined,
  resolvedIsolation?: "worktree",
): string | undefined {
  const lines: string[] = [];
  // A resolved agentType binds a real role prompt (the definition body). Only
  // fall back to the prose hint when the agentType named no known definition.
  if (def?.prompt) lines.push(def.prompt);
  else if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  if (phase) lines.push(`Workflow phase: ${phase}`);
  // Use resolvedIsolation so the annotation fires whether isolation came from
  // the call site or from the agentDef's isolation field.
  if (resolvedIsolation) lines.push(`Requested isolation: ${resolvedIsolation}`);
  // Note: options.model is applied for real via the session, not injected as prose.
  return lines.length ? lines.join("\n\n") : undefined;
}

function isEmptyTextAgentResult(result: unknown, schema: TSchema | undefined): boolean {
  return schema === undefined && typeof result === "string" && result.trim().length === 0;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function normalizeConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_CONCURRENCY, Math.floor(value));
}

function normalizeAgentRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_AGENT_RETRIES, Math.floor(value));
}

/**
 * Run a promise with a timeout.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number | null, label: string): Promise<T> {
  if (ms === null) return promise;

  let timeoutId: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new WorkflowError(
          `Agent "${label}" timed out after ${ms}ms; raise or omit timeoutMs/agentTimeoutMs to allow longer runs`,
          WorkflowErrorCode.AGENT_TIMEOUT,
          { recoverable: true },
        ),
      );
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
