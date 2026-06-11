import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";

export const SETTINGS_NAMESPACE = "effort";

/** All levels the extension knows about, including "off" (Pi's internal state). */
const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

/** Levels shown to users in usage and tab completion. */
export const USER_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly ThinkingLevel[];

/** Semantic aliases that resolve per model. */
const SEMANTIC_ALIASES = ["min", "max"] as const;

/** Fast mode subcommands. */
const FAST_MODE_ACTIONS = ["on", "off"] as const;

export type EffortLevel = (typeof ALL_LEVELS)[number];
export type EffortAlias = (typeof SEMANTIC_ALIASES)[number];
export type PiThinkingLevel = ThinkingLevel | "off";

/** Resolve the Pi ThinkingLevel from our EffortLevel. */
export function toThinkingLevel(level: EffortLevel): PiThinkingLevel {
  return level;
}

function isEffortLevel(value: string): value is EffortLevel {
  return ALL_LEVELS.includes(value as EffortLevel);
}

export function isEffortAlias(value: string): value is EffortAlias {
  return SEMANTIC_ALIASES.includes(value as EffortAlias);
}

export type EffortCommand =
  | { kind: "set-session"; level: EffortLevel }
  | { kind: "set-min" }
  | { kind: "set-max" };

export type FastCommand = { kind: "fast-set"; enabled: boolean } | { kind: "fast-toggle" };

export type EffortModel = Pick<Model<any>, "id" | "provider" | "reasoning" | "thinkingLevelMap">;

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = Math.min(prev + 1, dp[j] + 1, dp[j - 1] + 1);
      }
      prev = temp;
    }
  }
  return dp[n];
}

function suggestClosest(input: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const dist = levenshteinDistance(input, candidate);
    if (dist < bestDist && dist <= 2) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

const EFFORT_TOKEN_CANDIDATES = [...USER_LEVELS, ...SEMANTIC_ALIASES];

export function parseEffortCommand(args: string): EffortCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  if (tokens.length !== 1) {
    throw new Error(USAGE);
  }

  const [first] = tokens;
  if (first === "max") return { kind: "set-max" };
  if (first === "min") return { kind: "set-min" };
  if (USER_LEVELS.includes(first as ThinkingLevel)) return { kind: "set-session", level: first as EffortLevel };

  const suggestion = suggestClosest(first, EFFORT_TOKEN_CANDIDATES);
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
  throw new Error(`Unknown effort level "${first}".${hint}\n${USAGE}`);
}

export function parseFastCommand(args: string): FastCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) return { kind: "fast-toggle" };
  if (tokens.length !== 1) {
    throw new Error(FAST_USAGE);
  }

  const [first] = tokens;
  if (first === "on") return { kind: "fast-set", enabled: true };
  if (first === "off") return { kind: "fast-set", enabled: false };

  const suggestion = suggestClosest(first, FAST_MODE_ACTIONS);
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
  throw new Error(`Unknown fast mode "${first}".${hint}\n${FAST_USAGE}`);
}

/** Levels available for the given model, including "off". */
export function getAvailableThinkingLevels(model: EffortModel | null | undefined): EffortLevel[] {
  if (!model) return ["off"];
  return getSupportedThinkingLevels(model as Model<any>).filter(isEffortLevel);
}

/** Levels shown to the user for the given model (excludes "off"). */
export function getUserFacingLevels(model: EffortModel | null | undefined): EffortLevel[] {
  return getAvailableThinkingLevels(model).filter((level) => level !== "off");
}

/** Resolve "min" to the lowest reasoning level for the model. */
export function resolveMinLevel(model: EffortModel | null | undefined): EffortLevel | undefined {
  if (!model?.reasoning) return undefined;
  return "minimal";
}

/** Resolve "max" to the highest available level for the model. */
export function resolveMaxLevel(model: EffortModel | null | undefined): EffortLevel | undefined {
  if (!model?.reasoning) return undefined;
  return getAvailableThinkingLevels(model).includes("xhigh") ? "xhigh" : "high";
}

/** Resolve a user-facing level or semantic alias against the active model. */
export function resolveEffortLevel(
  value: EffortLevel | EffortAlias,
  model: EffortModel | null | undefined,
): EffortLevel | undefined {
  if (value === "min") return resolveMinLevel(model);
  if (value === "max") return resolveMaxLevel(model);
  return value;
}

/** Cycle to the next user-facing effort level for the given model. Wraps around. */
export function cycleLevel(current: string, model: EffortModel | null | undefined): EffortLevel | undefined {
  const levels = getUserFacingLevels(model);
  if (levels.length === 0) return undefined;
  const idx = levels.indexOf(current as EffortLevel);
  if (idx === -1) return levels[0];
  return levels[(idx + 1) % levels.length];
}

export function isFastModelId(modelId: string): boolean {
  return modelId.startsWith("gpt-5") || modelId.includes("/gpt-5") || modelId.startsWith("openai-codex/");
}

function readSettingsObject(settingsPath: string): Record<string, unknown> {
  try {
    const raw = readFileSync(settingsPath, "utf-8").trim();
    if (raw.length === 0) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("settings.json is not a JSON object");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function writeSettingsObject(settingsPath: string, settings: Record<string, unknown>): void {
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  const dir = dirname(settingsPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.settings.json.tmp.${process.pid}.${randomUUID()}`);

  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, settingsPath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

function readEffortSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const value = settings[SETTINGS_NAMESPACE];
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

export function getFastMode(settingsPath: string): boolean {
  try {
    const settings = readSettingsObject(settingsPath);
    const effort = readEffortSettings(settings);
    return effort.fastMode === true;
  } catch {
    return false;
  }
}

export function writeFastMode(settingsPath: string, enabled: boolean): void {
  const settings = readSettingsObject(settingsPath);
  const effort = readEffortSettings(settings);
  effort.fastMode = enabled;
  settings[SETTINGS_NAMESPACE] = effort;
  writeSettingsObject(settingsPath, settings);
}

export const USAGE = "Usage: /effort {min|minimal|low|medium|high|xhigh|max}";
export const FAST_USAGE = "Usage: /fast [on|off]";
