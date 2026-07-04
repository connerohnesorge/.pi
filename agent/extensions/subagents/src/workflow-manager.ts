/**
 * Workflow manager for background execution, pause/resume, and run management.
 */

import { EventEmitter } from "node:events";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgent } from "./agent.ts";
import { preview, type WorkflowSnapshot } from "./display.ts";
import { WorkflowError, WorkflowErrorCode } from "./errors.ts";
import {
  createRunPersistence,
  generateRunId,
  type PersistedRunState,
  type RunLease,
  type RunPersistence,
  type RunStatus,
} from "./run-persistence.ts";
import { type JournalEntry, parseWorkflowScript, runWorkflow, type WorkflowMeta, type WorkflowRunResult } from "./workflow.ts";

export interface ManagedRun {
  runId: string;
  status: RunStatus;
  snapshot: WorkflowSnapshot;
  result?: WorkflowRunResult;
  error?: WorkflowError;
  controller: AbortController;
  startedAt: Date;
  /** The real script, kept so the run can be resumed. */
  script: string;
  args?: unknown;
  /** Accumulated agent results for resume (deterministic call index -> result). */
  journal: JournalEntry[];
  /** Cross-process execution lease for this run, when it is actively executing. */
  lease?: RunLease;
  /**
   * True when the run was started in the background (or resumed) and the caller is
   * not awaiting its result inline. Only background runs deliver their result back
   * into the conversation; a foreground sync run already returns it as the tool
   * result, so re-delivering would duplicate it.
   */
  background: boolean;
}

/** Per-execution options shared by sync, background, and resume runs. */
export interface ExecOptions {
  /** Replay these journaled agent results for the unchanged prefix (resume). */
  resumeJournal?: Map<number, JournalEntry>;
  /** Cap on total agents for this run. */
  maxAgents?: number;
  /** Per-agent timeout in milliseconds. null/omitted means no hard timeout. */
  agentTimeoutMs?: number | null;
  /** Host signal (e.g. tool/Esc) that should abort this run when fired. */
  externalSignal?: AbortSignal;
  /** Called with the live snapshot on every progress event. */
  onProgress?: (snapshot: WorkflowSnapshot) => void;
  /** Hard token budget for this run; once spent reaches it, agent() throws. */
  tokenBudget?: number | null;
  /** Max concurrent agents for this execution. */
  concurrency?: number;
  /** Retry attempts after recoverable agent failures for this execution. */
  agentRetries?: number;
  /** Resolve a checkpoint() question with a human reply (only for UI-bearing runs). */
  confirm?: (promptText: string, options: unknown) => Promise<unknown>;
}

function createInitialSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
  return {
    name: meta.name,
    description: meta.description,
    phases: meta.phases?.map((p) => p.title) ?? [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
  };
}

export interface WorkflowManagerOptions {
  cwd?: string;
  concurrency?: number;
  /** Resolve a saved-workflow name to its script, enabling nested `workflow('name')`. */
  loadSavedWorkflow?: (name: string) => string | undefined;
  /** Inject a custom agent runner (tests); defaults to a real subagent session. */
  agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  mainModel?: string;
  /**
   * The host Pi session's model registry. When provided, workflow subagents
   * resolve models against the same registry as the main session, including
   * extension-registered providers such as ollama-cloud.
   */
  modelRegistry?: ModelRegistry;
  /** The pi session id to tag runs with (see setSessionId). */
  sessionId?: string;
  /** Default per-agent timeout when a run does not pass agentTimeoutMs. null means no hard timeout. */
  defaultAgentTimeoutMs?: number | null;
  /** Default retry attempts after recoverable agent failures. */
  defaultAgentRetries?: number;
}

export class WorkflowManager extends EventEmitter {
  private runs = new Map<string, ManagedRun>();
  private persistence: RunPersistence;
  private cwd: string;
  private concurrency: number;
  private loadSavedWorkflow?: (name: string) => string | undefined;
  private agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  private mainModel?: string;
  /** The host Pi session's model registry, shared with subagents. */
  private modelRegistry?: ModelRegistry;
  /** The current pi session id; runs are stamped with it and listRuns() filters by it. */
  private sessionId?: string;
  private defaultAgentTimeoutMs: number | null;
  private defaultAgentRetries: number;

  constructor(options: WorkflowManagerOptions = {}) {
    super();
    this.cwd = options.cwd ?? process.cwd();
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.agent = options.agent;
    this.mainModel = options.mainModel;
    this.modelRegistry = options.modelRegistry;
    this.sessionId = options.sessionId;
    this.defaultAgentTimeoutMs = options.defaultAgentTimeoutMs ?? null;
    this.defaultAgentRetries = options.defaultAgentRetries ?? 0;
    this.persistence = createRunPersistence(this.cwd);
    this.recoverStaleRuns();
  }

  /** Bind the manager to the current pi session, so new runs are tagged with it and
   * the navigator/task-panel show only this session's runs (set on session_start). */
  setSessionId(id: string | undefined): void {
    this.sessionId = id;
  }

  /**
   * On startup, any persisted run still marked "running" belongs to a process
   * that died mid-run (this fresh manager has it nowhere in memory). Reconcile it
   * to "paused" — never "failed" — so its journal is preserved and resume() can
   * replay the completed prefix and finish the rest.
   */
  private recoverStaleRuns(): void {
    try {
      for (const p of this.listAllRuns()) {
        if (p.status === "running" && !this.runs.has(p.runId)) {
          const lease = this.persistence.acquireRunLease(p.runId);
          if (!lease) continue;
          try {
            this.persistence.save({ ...p, status: "paused" });
          } finally {
            this.persistence.releaseRunLease(lease);
          }
        }
      }
    } catch {
      // Recovery is best-effort; never let it block manager construction.
    }
  }

  /** Set the session's main model (provider/id). Used to auto-tier explore agents. */
  setMainModel(spec: string | undefined): void {
    this.mainModel = spec;
  }

  /** Set the host session's model registry so subagents resolve models consistently. */
  setModelRegistry(registry: ModelRegistry): void {
    this.modelRegistry = registry;
  }

  /**
   * The host session's model registry, when set. Read lazily (e.g. by the
   * workflow tool's model routing guideline) since `setModelRegistry` is called
   * from `session_start`, which runs after the tool is created — a snapshot
   * taken at tool-creation time would miss it.
   */
  // Used lazily by workflow-tool prompt guidelines.
  // fallow-ignore-next-line unused-class-member
  getModelRegistry(): ModelRegistry | undefined {
    return this.modelRegistry;
  }

  /**
   * Start a workflow in the background.
   * Returns immediately with a run ID; the workflow executes asynchronously.
   */
  startInBackground(
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    const runId = generateRunId();
    const controller = new AbortController();
    const parsed = parseWorkflowScript(script);
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${runId}`);

    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: createInitialSnapshot(parsed.meta),
      controller,
      startedAt: new Date(),
      script,
      args,
      journal: [],
      background: true,
      lease,
    };

    this.runs.set(runId, managed);

    try {
      // Persist initial state
      this.persistence.save({
        runId,
        workflowName: parsed.meta.name,
        script,
        args,
        sessionId: this.sessionId,
        status: "running",
        phases: managed.snapshot.phases,
        agents: [],
        logs: [],
        startedAt: managed.startedAt.toISOString(),
        updatedAt: managed.startedAt.toISOString(),
      });
    } catch (err) {
      this.releaseRunLease(managed);
      this.runs.delete(runId);
      throw err;
    }

    // Run workflow asynchronously.
    // Attach a side-channel catch to prevent Node.js unhandled-rejection crashes
    // when a workflow is aborted/paused/stopped — executeRun()'s catch block
    // already records status/event/persist, but the promise still rejects.
    // The original promise is returned so callers can await it in try/catch.
    const promise = this.executeRun(managed, script, args, exec);
    promise.catch(() => {});

    return { runId, promise };
  }

  /**
   * Execute a workflow synchronously (blocking) while still tracking it like a
   * background run, so the `/workflows` navigator and the live task panel see it.
   * `onProgress` fires on every progress event with the current snapshot, letting
   * a caller (e.g. the workflow tool) drive its own inline display.
   */
  async runSync(script: string, args?: unknown, exec: ExecOptions = {}): Promise<WorkflowRunResult> {
    const managed = this.createManaged(script, args);
    const lease = this.persistence.acquireRunLease(managed.runId);
    if (!lease) throw new Error(`Could not acquire workflow run lease for ${managed.runId}`);
    managed.lease = lease;
    this.runs.set(managed.runId, managed);
    // Persist the initial state immediately so listRuns()/the task panel can see
    // the run the moment it starts, not only after the first agent journals.
    this.persistRun(managed);
    return this.executeRun(managed, script, args, exec);
  }

  /** Build a fresh managed run with an empty snapshot. */
  private createManaged(script: string, args?: unknown): ManagedRun {
    const parsed = parseWorkflowScript(script);
    return {
      runId: generateRunId(),
      status: "running",
      snapshot: createInitialSnapshot(parsed.meta),
      controller: new AbortController(),
      startedAt: new Date(),
      script,
      args,
      journal: [],
      background: false,
    };
  }

  private async executeRun(
    managed: ManagedRun,
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): Promise<WorkflowRunResult> {
    this.bindExternalAbort(managed, exec.externalSignal);
    try {
      const result = await runWorkflow(script, {
        ...this.workflowRunOptions(managed, args, exec),
        ...this.workflowRunHandlers(managed, exec.onProgress),
      });
      this.completeRun(managed, result);
      return result;
    } catch (error) {
      this.failRun(managed, error);
    }
  }

  private bindExternalAbort(managed: ManagedRun, externalSignal?: AbortSignal): void {
    if (!externalSignal) return;
    if (externalSignal.aborted) managed.controller.abort();
    else externalSignal.addEventListener("abort", () => managed.controller.abort(), { once: true });
  }

  private workflowRunOptions(managed: ManagedRun, args: unknown, exec: ExecOptions) {
    const agentTimeoutMs = exec.agentTimeoutMs !== undefined ? exec.agentTimeoutMs : this.defaultAgentTimeoutMs;
    const resumeJournal = exec.resumeJournal;
    return {
      cwd: this.cwd,
      args,
      agent: this.agent,
      mainModel: this.mainModel,
      modelRegistry: this.modelRegistry,
      signal: managed.controller.signal,
      concurrency: exec.concurrency ?? this.concurrency,
      agentRetries: exec.agentRetries ?? this.defaultAgentRetries,
      maxAgents: exec.maxAgents,
      agentTimeoutMs,
      tokenBudget: exec.tokenBudget,
      confirm: exec.confirm,
      loadSavedWorkflow: this.loadSavedWorkflow,
      resumeJournal,
      resumeFromRunId: resumeJournal ? managed.runId : undefined,
    };
  }

  private workflowRunHandlers(managed: ManagedRun, onProgress?: (snapshot: WorkflowSnapshot) => void) {
    const progress = () => onProgress?.(managed.snapshot);
    return {
      onAgentJournal: (entry) => {
        // Append (crash-safe-ish): keep the latest entry per index, then persist.
        managed.journal = managed.journal.filter((e) => e.index !== entry.index);
        managed.journal.push(entry);
        this.persistRun(managed);
      },
      onLog: (message) => {
        managed.snapshot.logs.push(message);
        this.emit("log", { runId: managed.runId, message });
        progress();
      },
      onPhase: (title) => {
        managed.snapshot.currentPhase = title;
        if (!managed.snapshot.phases.includes(title)) managed.snapshot.phases.push(title);
        this.emit("phase", { runId: managed.runId, title });
        progress();
      },
      onAgentStart: (event) => {
        managed.snapshot.agents.push({
          id: managed.snapshot.agents.length + 1,
          label: event.label,
          phase: event.phase,
          prompt: event.prompt,
          status: "running",
          model: event.model,
        });
        this.emit("agentStart", { runId: managed.runId, ...event });
        progress();
      },
      onAgentEnd: (event) => {
        const agent = this.latestRunningAgent(managed, event.label);
        if (agent) {
          agent.status = event.result === null ? "error" : "done";
          agent.resultPreview = preview(event.result);
          agent.error = event.error;
          agent.errorCode = event.errorCode;
          agent.recoverable = event.recoverable;
          agent.tokens = event.tokens;
          if (event.model) agent.model = event.model;
        }
        this.emit("agentEnd", { runId: managed.runId, ...event });
        progress();
      },
      onAgentHistory: (event) => {
        const agent = this.latestRunningAgent(managed, event.label);
        if (agent) agent.history = event.history;
        this.emit("agentHistory", { runId: managed.runId, ...event });
        progress();
      },
      onTokenUsage: (usage) => {
        managed.snapshot.tokenUsage = usage;
        this.emit("tokenUsage", { runId: managed.runId, usage });
        progress();
      },
    };
  }

  private latestRunningAgent(managed: ManagedRun, label: string) {
    return [...managed.snapshot.agents].reverse().find((a) => a.label === label && a.status === "running");
  }

  private completeRun(managed: ManagedRun, result: WorkflowRunResult): void {
    managed.status = "completed";
    managed.result = result;
    this.emit("complete", { runId: managed.runId, result });
    this.persistRun(managed);
    this.releaseRunLease(managed);
  }

  private failRun(managed: ManagedRun, error: unknown): never {
    const workflowError = this.toWorkflowError(error);
    const usageLimitPaused =
      !managed.controller.signal.aborted && workflowError.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;

    if (managed.controller.signal.aborted) {
      // Intentional abort (pause/stop/Esc) — preserve status set by pause()/stop()
      if (managed.status === "running") managed.status = "aborted";
    } else {
      managed.status = usageLimitPaused ? "paused" : "failed";
    }

    managed.error = workflowError;
    this.emitRunFailure(managed, workflowError, usageLimitPaused);
    this.persistRun(managed);
    this.releaseRunLease(managed);
    throw workflowError;
  }

  private toWorkflowError(error: unknown): WorkflowError {
    if (error instanceof WorkflowError) return error;
    return new WorkflowError(
      error instanceof Error ? error.message : String(error),
      WorkflowErrorCode.WORKFLOW_ABORTED,
      { recoverable: true },
    );
  }

  private emitRunFailure(managed: ManagedRun, error: WorkflowError, usageLimitPaused: boolean): void {
    if (!usageLimitPaused) {
      this.emit("error", { runId: managed.runId, error });
      return;
    }
    this.emit("paused", {
      runId: managed.runId,
      reason: "usage_limit",
      error,
      resetHint: error.resetHint,
    });
  }

  private releaseRunLease(managed: ManagedRun): void {
    if (!managed.lease) return;
    this.persistence.releaseRunLease(managed.lease);
    managed.lease = undefined;
  }

  private persistRun(managed: ManagedRun) {
    try {
      this.persistence.save(this.toPersistedRun(managed));
    } catch (err) {
      // Persistence is best-effort: the run is still healthy in memory.
      // Log so an operator debugging state-loss has a lead, but never crash
      // the workflow over a disk-full situation.
      console.warn("[workflow-manager] Persist run failed:", err);
    }
  }

  private toPersistedRun(managed: ManagedRun): PersistedRunState {
    const now = new Date().toISOString();
    return {
      runId: managed.runId,
      workflowName: managed.snapshot.name,
      // Persist the real script + journal so the run can be resumed. Runs live
      // in workflow run storage — protect via directory permissions, not blanking.
      script: managed.script,
      args: managed.args,
      sessionId: this.sessionId,
      journal: managed.journal,
      status: managed.status,
      ...this.pauseMetadata(managed),
      phases: managed.snapshot.phases,
      currentPhase: managed.snapshot.currentPhase,
      agents: managed.snapshot.agents.map((a) => ({ ...a, startedAt: managed.startedAt.toISOString(), endedAt: now })),
      logs: managed.snapshot.logs,
      result: managed.result?.result,
      tokenUsage: this.persistedTokenUsage(managed),
      startedAt: managed.startedAt.toISOString(),
      updatedAt: now,
      completedAt: managed.status === "completed" ? now : undefined,
      durationMs: managed.result?.durationMs,
    };
  }

  private pauseMetadata(managed: ManagedRun) {
    if (managed.status !== "paused" || managed.error?.code !== WorkflowErrorCode.PROVIDER_USAGE_LIMIT) return {};
    return { pauseReason: "usage_limit", resetHint: managed.error.resetHint };
  }

  private persistedTokenUsage(managed: ManagedRun) {
    const usage = managed.snapshot.tokenUsage;
    if (!usage) return undefined;
    return {
      input: usage.input,
      output: usage.output,
      total: usage.total,
      cost: usage.cost,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
    };
  }

  /**
   * Pause a running workflow.
   */
  pause(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed?.status !== "running") return false;

    managed.controller.abort();
    managed.status = "paused";
    this.emit("paused", { runId });
    this.persistRun(managed);
    this.releaseRunLease(managed);
    return true;
  }

  /**
   * Resume an interrupted run: replay journaled results for the unchanged prefix
   * and run the rest live. Returns false if there is nothing resumable.
   */
  async resume(runId: string): Promise<boolean> {
    const resumed = this.acquireResumableRun(runId);
    if (!resumed) return false;

    const { managed, persisted } = resumed;
    this.runs.set(runId, managed);
    this.emit("resumed", { runId });
    // Run in the background; executeRun records status/errors on the managed run.
    void this.executeRun(managed, persisted.script, persisted.args, {
      resumeJournal: new Map((persisted.journal ?? []).map((e) => [e.index, e] as const)),
    }).catch(() => {});
    return true;
  }

  private acquireResumableRun(runId: string) {
    if (!this.canResumeActiveRun(runId)) return null;
    const persisted = this.persistence.load(runId);
    if (!this.canResumePersistedRun(persisted)) return null;
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return null;
    return { persisted, managed: this.createResumedManagedRun(runId, persisted, lease) };
  }

  private canResumeActiveRun(runId: string): boolean {
    const active = this.runs.get(runId);
    return active?.status !== "running" && active?.status !== "aborted";
  }

  private canResumePersistedRun(persisted: PersistedRunState | null): persisted is PersistedRunState & { script: string } {
    return Boolean(persisted?.script && persisted.status !== "completed" && persisted.status !== "aborted");
  }

  private createResumedManagedRun(
    runId: string,
    persisted: PersistedRunState & { script: string },
    lease: RunLease,
  ): ManagedRun {
    return {
      runId,
      status: "running",
      snapshot: {
        name: persisted.workflowName,
        phases: persisted.phases ?? [],
        logs: persisted.logs ?? [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller: new AbortController(),
      startedAt: new Date(),
      script: persisted.script,
      args: persisted.args,
      journal: persisted.journal ?? [],
      background: true,
      lease,
    };
  }

  /**
   * Stop a running workflow.
   */
  stop(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (!managed || (managed.status !== "running" && managed.status !== "paused")) return false;

    managed.controller.abort();
    managed.status = "aborted";
    this.emit("stopped", { runId });
    this.persistRun(managed);
    this.releaseRunLease(managed);
    return true;
  }

  /**
   * Get status of a specific run.
   */
  getRun(runId: string): ManagedRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * List all runs (active + persisted).
   */
  /**
   * Runs for the navigator/task panel. Once bound to a session (setSessionId), only
   * that session's runs are returned — runs from other sessions stay on disk and
   * reappear when you switch back. Unbound (tests/legacy) returns everything.
   */
  listRuns(): PersistedRunState[] {
    const all = this.persistence.list();
    return this.sessionId ? all.filter((r) => r.sessionId === this.sessionId) : all;
  }

  /** All persisted runs regardless of session (used by cross-session recovery). */
  listAllRuns(): PersistedRunState[] {
    return this.persistence.list();
  }

  /**
   * Get snapshot of a run.
   */
  getSnapshot(runId: string): WorkflowSnapshot | null {
    return this.runs.get(runId)?.snapshot ?? null;
  }

  /**
   * Delete a persisted run.
   */
  deleteRun(runId: string): boolean {
    const managed = this.runs.get(runId);
    if (managed) this.releaseRunLease(managed);
    this.runs.delete(runId);
    return this.persistence.delete(runId);
  }

  /**
   * Get the persistence layer (for saving workflows).
   */
  getPersistence(): RunPersistence {
    return this.persistence;
  }
}
