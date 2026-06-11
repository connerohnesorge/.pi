import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentUsage } from "../../src/agent.js";

/** Agent runner that reports fixed usage so token accounting is exercised. */
export function fakeAgent(usage: Partial<AgentUsage> = {}, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  };
}

/** Agent that stays running until a deferred resolve/reject is called externally. */
export function deferredAgent() {
  let deferredResolve: ((value: unknown) => void) | null = null;
  let deferredReject: ((err: Error) => void) | null = null;
  const promise = new Promise((resolve, reject) => {
    deferredResolve = resolve;
    deferredReject = reject;
  });
  return {
    resolve: (value: unknown = "done") => deferredResolve?.(value),
    reject: (err: Error) => deferredReject?.(err),
    runner: {
      async run(_prompt: string, _options?: { onUsage?: (u: AgentUsage) => void }) {
        return promise;
      },
    },
  };
}

/** Agent runner where each run() call receives its own externally resolved promise. */
export function createPerCallDeferredAgent() {
  const resolves: Array<(value: unknown) => void> = [];
  let callIdx = 0;
  return {
    resolve(idx: number, value: unknown = "done") {
      resolves[idx]?.(value);
    },
    runner: {
      async run(_prompt: string, _options?: { onUsage?: (u: AgentUsage) => void }) {
        const idx = callIdx++;
        return new Promise((resolve) => {
          resolves[idx] = resolve;
        });
      },
    },
  };
}

export const oneAgentScript = `export const meta = { name: 'tracked_demo', description: 'one agent' }
phase('Work')
const a = await agent('do it', { label: 'a' })
return { a }`;

export const twoAgentScript = `export const meta = { name: 'two_agent', description: 'two agents test' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }`;

/** Run each manager test in its own temp cwd so .pi/workflows/runs is isolated. */
export function makeTempCwdWrapper(prefix: string) {
  return function withTempCwd(fn: (cwd: string) => Promise<void>) {
    return async () => {
      const cwd = mkdtempSync(join(tmpdir(), prefix));
      try {
        await fn(cwd);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    };
  };
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
