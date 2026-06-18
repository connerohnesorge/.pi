import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LOOP_INTERVAL_MS,
  LOOP_USAGE,
  MIN_LOOP_INTERVAL_MS,
  formatLoopCleared,
  formatLoopInterval,
  formatLoopStarted,
  formatLoopStatus,
  formatLoopStatusKey,
  parseLoopCommand,
  parseLoopInterval,
  previewLoopIterations,
  type LoopJob,
} from "../loop.ts";

test("parseLoopInterval supports time units and rounds seconds up to one minute", () => {
  assert.deepEqual(parseLoopInterval("5m"), { intervalMs: 5 * MIN_LOOP_INTERVAL_MS, intervalLabel: "5m" });
  assert.deepEqual(parseLoopInterval("2h"), { intervalMs: 2 * 60 * MIN_LOOP_INTERVAL_MS, intervalLabel: "2h" });
  assert.deepEqual(parseLoopInterval("1d"), { intervalMs: 24 * 60 * MIN_LOOP_INTERVAL_MS, intervalLabel: "1d" });
  assert.deepEqual(parseLoopInterval("30s"), { intervalMs: MIN_LOOP_INTERVAL_MS, intervalLabel: "1m" });
  assert.equal(parseLoopInterval("soon"), null);
  assert.equal(parseLoopInterval("0m"), null);
});

test("parseLoopCommand defaults to ten minutes when no interval is present", () => {
  assert.deepEqual(parseLoopCommand("check prod logs"), {
    kind: "start",
    intervalMs: DEFAULT_LOOP_INTERVAL_MS,
    intervalLabel: "10m",
    task: "check prod logs",
  });
});

test("parseLoopCommand extracts interval and normalizes task whitespace", () => {
  assert.deepEqual(parseLoopCommand("  15m   run   the checks  "), {
    kind: "start",
    intervalMs: 15 * MIN_LOOP_INTERVAL_MS,
    intervalLabel: "15m",
    task: "run the checks",
  });
});

test("parseLoopCommand supports status and clear", () => {
  assert.deepEqual(parseLoopCommand(""), { kind: "status" });
  assert.deepEqual(parseLoopCommand(" --status "), { kind: "status" });
  assert.deepEqual(parseLoopCommand(" --clear "), { kind: "clear" });
  assert.throws(() => parseLoopCommand("5m"), new RegExp(LOOP_USAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("format helpers describe jobs", () => {
  const job: LoopJob = {
    id: 1,
    task: "review progress",
    intervalMs: DEFAULT_LOOP_INTERVAL_MS,
    intervalLabel: "10m",
    createdAt: 0,
    nextRunAt: DEFAULT_LOOP_INTERVAL_MS,
  };

  assert.equal(formatLoopInterval(3 * MIN_LOOP_INTERVAL_MS), "3m");
  assert.equal(formatLoopStarted(job), "Loop #1 running every 10m: review progress");
  assert.equal(formatLoopStatusKey([]), undefined);
  assert.equal(formatLoopStatusKey([job]), "loop:1");
  assert.equal(formatLoopStatus([], 0), "No loops running.");
  assert.equal(formatLoopStatus([job], 0), "#1 every 10m (next in 10m): review progress");
  assert.equal(formatLoopCleared(0), "No loops were running.");
  assert.equal(formatLoopCleared(2), "Stopped 2 loops.");
});

test("previewLoopIterations returns the next five run times", () => {
  assert.deepEqual(previewLoopIterations(MIN_LOOP_INTERVAL_MS, 0, 5), [
    new Date(MIN_LOOP_INTERVAL_MS).toLocaleString(),
    new Date(2 * MIN_LOOP_INTERVAL_MS).toLocaleString(),
    new Date(3 * MIN_LOOP_INTERVAL_MS).toLocaleString(),
    new Date(4 * MIN_LOOP_INTERVAL_MS).toLocaleString(),
    new Date(5 * MIN_LOOP_INTERVAL_MS).toLocaleString(),
  ]);
});
