/**
 * Workflow run state persistence for pause/resume support.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentHistoryEntry } from "./agent-history.ts";
import type { WorkflowErrorCode } from "./errors.ts";
import { workflowProjectPaths } from "./workflow-paths.ts";

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

export interface PersistedAgentState {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  result?: unknown;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  startedAt?: string;
  endedAt?: string;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
}

export interface PersistedRunState {
  runId: string;
  workflowName: string;
  script: string;
  args?: unknown;
  /** The pi session this run belongs to. Runs persist on disk across sessions but
   * the navigator shows only the current session's runs (undefined = legacy/global). */
  sessionId?: string;
  status: RunStatus;
  /** Why a paused run is paused (e.g. "usage_limit" when a provider quota was hit). */
  pauseReason?: string;
  /** Provider reset hint for a usage-limit pause, e.g. "Resets in ~3h" (verbatim). */
  resetHint?: string;
  phases: string[];
  currentPhase?: string;
  agents: PersistedAgentState[];
  logs: string[];
  result?: unknown;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /** Cached agent results for resume, keyed by deterministic call index. */
  journal?: Array<{ index: number; hash: string; result: unknown }>;
}

export interface RunPersistence {
  /** Save current run state. */
  save(state: PersistedRunState): void;
  /** Load a persisted run by ID. */
  load(runId: string): PersistedRunState | null;
  /** List all persisted runs. */
  list(): PersistedRunState[];
  /** Delete a persisted run. */
  delete(runId: string): boolean;
  /**
   * Acquire an exclusive cross-process lease for a run. Returns null when another
   * live process owns the run; stale/corrupt lock files are removed and retried.
   */
  acquireRunLease(runId: string): RunLease | null;
  /** Release a lease previously returned by acquireRunLease(). */
  releaseRunLease(lease: RunLease): void;
  /** Get runs directory path. */
  getRunsDir(): string;
}

export interface RunLease {
  runId: string;
  token: string;
}

interface LockFile {
  runId: string;
  runPath: string;
  pid: number;
  startedAt: string;
  token: string;
}

/**
 * Filesystem operations used by run persistence.
 * Exposed for testing – pass overrides to inject mock implementations.
 */
export type FsLayer = {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
};

type RunPaths = {
  runsDir: string;
  legacyRunsDir: string;
  primaryRunPath(runId: string): string;
  legacyRunPath(runId: string): string;
  primaryLockPath(runId: string): string;
  legacyLockPath(runId: string): string;
  candidateRunPaths(runId: string): string[];
};

export function createRunPersistence(cwd: string, fsOverride?: Partial<FsLayer>): RunPersistence {
  const fs = createFsLayer(fsOverride);
  const paths = createRunPaths(cwd);

  return {
    save: (state) => saveRunState(state, fs, paths),
    load: (runId) => loadRunState(runId, fs, paths),
    list: () => listRunStates(fs, paths),
    delete: (runId) => deleteRunState(runId, fs, paths),
    acquireRunLease: (runId) => acquireRunLease(runId, fs, paths),
    releaseRunLease: (lease) => releaseRunLease(lease, fs, paths),
    getRunsDir: () => paths.runsDir,
  };
}

function createFsLayer(fsOverride?: Partial<FsLayer>): FsLayer {
  return {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
    ...fsOverride,
  };
}

function createRunPaths(cwd: string): RunPaths {
  const paths = workflowProjectPaths(cwd);
  const runPath = (dir: string, runId: string) => join(dir, `${runId}.json`);
  const lockPath = (dir: string, runId: string) => join(dir, `${runId}.lock`);
  return {
    runsDir: paths.runsDir,
    legacyRunsDir: paths.legacyRunsDir,
    primaryRunPath: (runId) => runPath(paths.runsDir, runId),
    legacyRunPath: (runId) => runPath(paths.legacyRunsDir, runId),
    primaryLockPath: (runId) => lockPath(paths.runsDir, runId),
    legacyLockPath: (runId) => lockPath(paths.legacyRunsDir, runId),
    candidateRunPaths: (runId) => [runPath(paths.runsDir, runId), runPath(paths.legacyRunsDir, runId)],
  };
}

function ensureRunsDir(fs: FsLayer, paths: RunPaths): void {
  if (!fs.existsSync(paths.runsDir)) fs.mkdirSync(paths.runsDir, { recursive: true });
}

function saveRunState(state: PersistedRunState, fs: FsLayer, paths: RunPaths): void {
  ensureRunsDir(fs, paths);
  state.updatedAt = new Date().toISOString();
  const path = paths.primaryRunPath(state.runId);
  const json = JSON.stringify(state, null, 2);
  // Atomic write: tmp+rename is atomic on the same filesystem. The .bak is best-effort recovery.
  fs.writeFileSync(`${path}.tmp`, json);
  fs.renameSync(`${path}.tmp`, path);
  tryWriteBackup(fs, `${path}.bak`, json);
}

function tryWriteBackup(fs: FsLayer, path: string, json: string): void {
  try {
    fs.writeFileSync(path, json);
  } catch {
    // backup is best-effort; the primary write already succeeded
  }
}

function loadRunState(runId: string, fs: FsLayer, paths: RunPaths): PersistedRunState | null {
  for (const path of paths.candidateRunPaths(runId)) {
    const state = readFirstRunState(fs, [path, `${path}.bak`]);
    if (state) return state;
  }
  return null;
}

function readFirstRunState(fs: FsLayer, candidates: string[]): PersistedRunState | null {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return JSON.parse(fs.readFileSync(candidate, "utf-8")) as PersistedRunState;
    } catch {
      // corrupt candidate -> fall through to the next candidate
    }
  }
  return null;
}

function listRunStates(fs: FsLayer, paths: RunPaths): PersistedRunState[] {
  const byRunId = new Map<string, PersistedRunState>();
  addRunStatesFromDir(byRunId, paths.runsDir, fs);
  addRunStatesFromDir(byRunId, paths.legacyRunsDir, fs);
  return [...byRunId.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function addRunStatesFromDir(byRunId: Map<string, PersistedRunState>, dir: string, fs: FsLayer): void {
  try {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      addRunStateFile(byRunId, join(dir, file), fs);
    }
  } catch {
    // Skip unreadable directories; another storage location may still work.
  }
}

function addRunStateFile(byRunId: Map<string, PersistedRunState>, path: string, fs: FsLayer): void {
  try {
    const state = JSON.parse(fs.readFileSync(path, "utf-8")) as PersistedRunState;
    if (!byRunId.has(state.runId)) byRunId.set(state.runId, state);
  } catch {
    // Skip corrupted files
  }
}

function deleteRunState(runId: string, fs: FsLayer, paths: RunPaths): boolean {
  const files = [
    paths.primaryRunPath(runId),
    `${paths.primaryRunPath(runId)}.bak`,
    `${paths.primaryRunPath(runId)}.tmp`,
    paths.primaryLockPath(runId),
    paths.legacyRunPath(runId),
    `${paths.legacyRunPath(runId)}.bak`,
    `${paths.legacyRunPath(runId)}.tmp`,
    paths.legacyLockPath(runId),
  ];
  return deleteExistingFiles(files, fs);
}

function deleteExistingFiles(files: string[], fs: FsLayer): boolean {
  let deleted = false;
  for (const path of files) {
    try {
      if (fs.existsSync(path)) {
        fs.unlinkSync(path);
        deleted = true;
      }
    } catch {
      // ignore per-file cleanup failures
    }
  }
  return deleted;
}

function acquireRunLease(runId: string, fs: FsLayer, paths: RunPaths): RunLease | null {
  ensureRunsDir(fs, paths);
  if (!removeStaleLegacyLock(runId, fs, paths)) return null;
  return tryAcquirePrimaryLease(runId, fs, paths);
}

function tryAcquirePrimaryLease(runId: string, fs: FsLayer, paths: RunPaths): RunLease | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    const lease = writeLeaseOrInspectExisting(runId, fs, paths);
    if (lease !== "retry") return lease;
  }
  return null;
}

function writeLeaseOrInspectExisting(runId: string, fs: FsLayer, paths: RunPaths): RunLease | null | "retry" {
  const payload = newLockFile(runId, paths.primaryRunPath(runId));
  try {
    fs.writeFileSync(paths.primaryLockPath(runId), JSON.stringify(payload, null, 2), { flag: "wx" });
    return { runId, token: payload.token };
  } catch (err) {
    if ((err as { code?: string }).code !== "EEXIST") throw err;
    if (livePrimaryLockExists(runId, fs, paths)) return null;
    return removeLockForRetry(paths.primaryLockPath(runId), fs) ? "retry" : null;
  }
}

function newLockFile(runId: string, runPath: string): LockFile {
  return {
    runId,
    runPath,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  };
}

function livePrimaryLockExists(runId: string, fs: FsLayer, paths: RunPaths): boolean {
  const existing = readLockAt(paths.primaryLockPath(runId), fs);
  return Boolean(existing && existing.runPath === paths.primaryRunPath(runId) && pidIsAlive(existing.pid));
}

function removeLockForRetry(lock: string, fs: FsLayer): boolean {
  try {
    fs.unlinkSync(lock);
    return true;
  } catch {
    return false;
  }
}

function releaseRunLease(lease: RunLease, fs: FsLayer, paths: RunPaths): void {
  try {
    const existing = readLockAt(paths.primaryLockPath(lease.runId), fs);
    if (existing?.token === lease.token) fs.unlinkSync(paths.primaryLockPath(lease.runId));
  } catch {
    // Best-effort cleanup only.
  }
}

function removeStaleLegacyLock(runId: string, fs: FsLayer, paths: RunPaths): boolean {
  const lock = paths.legacyLockPath(runId);
  const existing = readLockAt(lock, fs);
  if (existing?.runId === runId && pidIsAlive(existing.pid)) return false;
  try {
    if (fs.existsSync(lock)) fs.unlinkSync(lock);
    return true;
  } catch {
    return false;
  }
}

function readLockAt(path: string, fs: FsLayer): LockFile | null {
  try {
    return JSON.parse(fs.readFileSync(path, "utf-8")) as LockFile;
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

/**
 * Generate a unique run ID.
 */
export function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}
