import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import {
  FAST_USAGE,
  SETTINGS_NAMESPACE,
  USAGE,
  USER_LEVELS,
  cycleLevel,
  getAvailableThinkingLevels,
  getFastMode,
  getUserFacingLevels,
  isFastModelId,
  parseEffortCommand,
  parseFastCommand,
  resolveEffortLevel,
  resolveMaxLevel,
  resolveMinLevel,
  writeFastMode,
} from "../effort.ts";

type _UncoveredLevels = Exclude<ThinkingLevel, (typeof USER_LEVELS)[number]>;
const _driftCheck: [_UncoveredLevels] extends [never] ? true : never = true;
void _driftCheck;

const standardReasoningModel = { id: "minimax/minimax-m2.7", provider: "openrouter", reasoning: true } as const;
const xhighReasoningModel = {
  id: "gpt-5.4",
  provider: "openai-codex",
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh" },
} as const;
const plainModel = { id: "plain-model", provider: "local", reasoning: false } as const;

test("parseEffortCommand handles explicit levels", () => {
  assert.deepEqual(parseEffortCommand("high"), { kind: "set-session", level: "high" });
  assert.deepEqual(parseEffortCommand("xhigh"), { kind: "set-session", level: "xhigh" });
  assert.deepEqual(parseEffortCommand("minimal"), { kind: "set-session", level: "minimal" });
});

test("parseEffortCommand handles min and max aliases", () => {
  assert.deepEqual(parseEffortCommand("min"), { kind: "set-min" });
  assert.deepEqual(parseEffortCommand("max"), { kind: "set-max" });
});

test("parseEffortCommand rejects anything outside the minimal surface", () => {
  assert.throws(() => parseEffortCommand(""), /Usage: \/effort/);
  assert.throws(() => parseEffortCommand("off"), /Unknown effort level/);
  assert.throws(() => parseEffortCommand("show"), /Unknown effort level/);
  assert.throws(() => parseEffortCommand("default high"), /Usage: \/effort/);
  assert.throws(() => parseEffortCommand("fast on"), /Usage: \/effort/);
});

test("parseEffortCommand suggests close matches", () => {
  assert.throws(() => parseEffortCommand("hihg"), /Did you mean "high"\?/);
  assert.throws(() => parseEffortCommand("mn"), /Did you mean "min"\?/);
  assert.throws(() => parseEffortCommand("maxe"), /Did you mean "max"\?/);
});

test("parseFastCommand toggles with no args and handles explicit overrides", () => {
  assert.deepEqual(parseFastCommand(""), { kind: "fast-toggle" });
  assert.deepEqual(parseFastCommand("on"), { kind: "fast-set", enabled: true });
  assert.deepEqual(parseFastCommand("off"), { kind: "fast-set", enabled: false });
  assert.throws(() => parseFastCommand("status"), /Unknown fast mode/);
  assert.throws(() => parseFastCommand("on off"), /Usage: \/fast/);
});

test("resolveMinLevel and resolveMaxLevel adapt to model capabilities", () => {
  assert.equal(resolveMinLevel(standardReasoningModel), "minimal");
  assert.equal(resolveMinLevel(plainModel), undefined);
  assert.equal(resolveMaxLevel(standardReasoningModel), "high");
  assert.equal(resolveMaxLevel(xhighReasoningModel), "xhigh");
  assert.equal(resolveMaxLevel(plainModel), undefined);
});

test("resolveEffortLevel resolves semantic aliases per model", () => {
  assert.equal(resolveEffortLevel("min", standardReasoningModel), "minimal");
  assert.equal(resolveEffortLevel("max", standardReasoningModel), "high");
  assert.equal(resolveEffortLevel("max", xhighReasoningModel), "xhigh");
  assert.equal(resolveEffortLevel("medium", standardReasoningModel), "medium");
  assert.equal(resolveEffortLevel("min", plainModel), undefined);
});

test("thinking level helpers expose supported model levels", () => {
  assert.deepEqual(getAvailableThinkingLevels(plainModel), ["off"]);
  assert.deepEqual(getUserFacingLevels(plainModel), []);
  assert.deepEqual(getAvailableThinkingLevels(standardReasoningModel), ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(getUserFacingLevels(standardReasoningModel), ["minimal", "low", "medium", "high"]);
  assert.deepEqual(getAvailableThinkingLevels(xhighReasoningModel), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
});

test("cycleLevel advances through user-facing levels", () => {
  assert.equal(cycleLevel("minimal", xhighReasoningModel), "low");
  assert.equal(cycleLevel("medium", xhighReasoningModel), "high");
  assert.equal(cycleLevel("xhigh", xhighReasoningModel), "minimal");
  assert.equal(cycleLevel("off", xhighReasoningModel), "minimal");
  assert.equal(cycleLevel("high", plainModel), undefined);
});

test("fast model detection covers GPT-5 and OpenAI-Codex identifiers", () => {
  assert.equal(isFastModelId("gpt-5.5"), true);
  assert.equal(isFastModelId("openai-codex/gpt-5.4"), true);
  assert.equal(isFastModelId("openai-codex/gpt-5.3-codex"), true);
  assert.equal(isFastModelId("claude-opus-4.6"), false);
});

test("writeFastMode preserves unrelated settings and writes effort namespace", () => {
  const dir = mkdtempSync(join(tmpdir(), "effort-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "openai-codex" }, null, 2));

  writeFastMode(settingsPath, true);

  const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
  assert.equal(parsed.defaultProvider, "openai-codex");
  assert.equal(parsed[SETTINGS_NAMESPACE].fastMode, true);
  assert.equal(getFastMode(settingsPath), true);

  writeFastMode(settingsPath, false);
  assert.equal(getFastMode(settingsPath), false);
});

test("getFastMode returns false when unset or corrupt", () => {
  const dir = mkdtempSync(join(tmpdir(), "effort-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ otherKey: "value" }, null, 2));
  assert.equal(getFastMode(settingsPath), false);

  writeFileSync(settingsPath, "{not json}");
  assert.equal(getFastMode(settingsPath), false);
});

test("usage exposes only effort and fast primitives", () => {
  assert.match(USAGE, /min/);
  assert.match(USAGE, /max/);
  assert.match(USAGE, /\/effort/);
  assert.doesNotMatch(USAGE, /default|options|show|fast/);
  assert.equal(FAST_USAGE, "Usage: /fast [on|off]");
});
