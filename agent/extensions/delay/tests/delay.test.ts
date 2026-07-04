import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DELAY_MS,
  DELAY_USAGE,
  MIN_DELAY_MS,
  formatDelayCleared,
  formatDelayDuration,
  formatDelayScheduled,
  formatDelayStatus,
  formatDelayStatusKey,
  parseDelayCommand,
  parseDelayDuration,
  previewDelayDelivery,
  type DelayJob,
} from "../delay.ts";

test("parseDelayDuration supports time units and rounds seconds up to one minute", () => {
  assert.deepEqual(parseDelayDuration("5m"), { delayMs: 5 * MIN_DELAY_MS, delayLabel: "5m" });
  assert.deepEqual(parseDelayDuration("2h"), { delayMs: 2 * 60 * MIN_DELAY_MS, delayLabel: "2h" });
  assert.deepEqual(parseDelayDuration("1d"), { delayMs: 24 * 60 * MIN_DELAY_MS, delayLabel: "1d" });
  assert.deepEqual(parseDelayDuration("30s"), { delayMs: MIN_DELAY_MS, delayLabel: "1m" });
  assert.equal(parseDelayDuration("soon"), null);
  assert.equal(parseDelayDuration("0m"), null);
});

test("parseDelayCommand defaults to ten minutes when no delay is present", () => {
  assert.deepEqual(parseDelayCommand("check prod logs"), {
    kind: "start",
    delayMs: DEFAULT_DELAY_MS,
    delayLabel: "10m",
    message: "check prod logs",
  });
});

test("parseDelayCommand extracts delay and normalizes message whitespace", () => {
  assert.deepEqual(parseDelayCommand("  15m   run   the checks  "), {
    kind: "start",
    delayMs: 15 * MIN_DELAY_MS,
    delayLabel: "15m",
    message: "run the checks",
  });
});

test("parseDelayCommand supports status and clear", () => {
  assert.deepEqual(parseDelayCommand(""), { kind: "status" });
  assert.deepEqual(parseDelayCommand(" --status "), { kind: "status" });
  assert.deepEqual(parseDelayCommand(" --clear "), { kind: "clear" });
  assert.throws(() => parseDelayCommand("5m"), new RegExp(DELAY_USAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("format helpers describe delayed jobs", () => {
  const job: DelayJob = {
    id: 1,
    message: "review progress",
    delayMs: DEFAULT_DELAY_MS,
    delayLabel: "10m",
    createdAt: 0,
    sendAt: DEFAULT_DELAY_MS,
  };

  assert.equal(formatDelayDuration(3 * MIN_DELAY_MS), "3m");
  assert.equal(formatDelayScheduled(job), "Delay #1 scheduled in 10m: review progress");
  assert.equal(formatDelayStatusKey([]), undefined);
  assert.equal(formatDelayStatusKey([job]), "delay:1");
  assert.equal(formatDelayStatus([], 0), "No delayed messages scheduled.");
  assert.equal(formatDelayStatus([job], 0), "#1 in 10m (sends in 10m): review progress");
  assert.equal(formatDelayCleared(0), "No delayed messages were scheduled.");
  assert.equal(formatDelayCleared(2), "Cancelled 2 delays.");
});

test("previewDelayDelivery returns the scheduled delivery time", () => {
  assert.equal(previewDelayDelivery(MIN_DELAY_MS, 0), new Date(MIN_DELAY_MS).toLocaleString());
});
