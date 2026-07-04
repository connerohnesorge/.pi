/**
 * Model tier configuration for workflow subagent model routing.
 *
 * A tier is a named slot (small/medium/big) holding exactly ONE model spec
 * string. Specs may include a Pi thinking suffix, e.g. `openai-codex/gpt-5.5:high`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MODEL_TIERS_FILE } from "./config.ts";

export interface ModelTierConfig {
  tiers: Record<string, string>;
}

const DEFAULT_GPT55_MODEL = "openai-codex/gpt-5.5";

const DEFAULT_MODEL_TIER_CONFIG: ModelTierConfig = {
  tiers: {
    small: `${DEFAULT_GPT55_MODEL}:low`,
    medium: `${DEFAULT_GPT55_MODEL}:medium`,
    big: `${DEFAULT_GPT55_MODEL}:high`,
  },
};

/** Path to the model tiers JSON config file (~/.pi/workflows/model-tiers.json). */
function getModelTierConfigPath(): string {
  return join(homedir(), MODEL_TIERS_FILE);
}

/** Build the default tier config: GPT-5.5 at increasing reasoning levels. */
export function buildDefaultTierConfig(_currentModelSpec?: string, _availableModels?: string[]): ModelTierConfig {
  return { tiers: { ...DEFAULT_MODEL_TIER_CONFIG.tiers } };
}

/** Load the model tier config from disk. Returns null if missing or invalid. */
export function loadModelTierConfig(configPath?: string): ModelTierConfig | null {
  const path = configPath ?? getModelTierConfigPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return isModelTierConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isModelTierConfig(value: unknown): value is ModelTierConfig {
  if (!value || typeof value !== "object") return false;
  const tiers = (value as Partial<ModelTierConfig>).tiers;
  return Boolean(tiers && typeof tiers === "object" && Object.values(tiers).every((val) => typeof val === "string"));
}

/** Save a model tier config to disk. Creates parent directories if needed. */
export function saveModelTierConfig(config: ModelTierConfig, configPath?: string): void {
  const path = configPath ?? getModelTierConfigPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

/** Resolve a tier name to its configured model spec, or undefined if absent. */
export function resolveTierModel(tier: string, config: ModelTierConfig): string | undefined {
  return config.tiers[tier];
}

/** Return all tier names sorted: small < medium < big, then alphabetically. */
export function sortedTierNames(config: ModelTierConfig): string[] {
  const names = Object.keys(config.tiers);
  const rank: Record<string, number> = { small: 0, medium: 1, big: 2 };
  return names.sort((a, b) => (rank[a] ?? 99) - (rank[b] ?? 99) || a.localeCompare(b));
}
