import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  USER_LEVELS,
  type EffortLevel,
  type EffortModel,
  cycleLevel,
  getAvailableThinkingLevels,
  getFastMode,
  getUserFacingLevels,
  isEffortAlias,
  isFastModelId,
  parseEffortCommand,
  parseFastCommand,
  resolveEffortLevel,
  resolveMaxLevel,
  resolveMinLevel,
  toThinkingLevel,
  writeFastMode,
} from "./effort.ts";

function modelName(model: EffortModel | null | undefined): string {
  return model?.id ?? "current model";
}

function formatAvailableLevels(model: EffortModel | null | undefined): string {
  return getAvailableThinkingLevels(model).join(", ");
}

function isFastModeApplicable(model: EffortModel | null | undefined): boolean {
  return typeof model?.id === "string" && isFastModelId(model.provider ? `${model.provider}/${model.id}` : model.id);
}

function updateEffortUi(ctx: ExtensionContext, current: string, fastMode: boolean, updateWorkingMessage = true): void {
  ctx.ui.setStatus("effort-thinking", `think:${current}`);
  ctx.ui.setStatus("effort-fast", fastMode && isFastModeApplicable(ctx.model) ? "fast" : undefined);
  if (updateWorkingMessage) {
    ctx.ui.setWorkingMessage(current === "off" ? undefined : `Working (${current} effort)...`);
  }
}

function applySessionLevel(pi: ExtensionAPI, ctx: ExtensionContext, level: EffortLevel, fastMode: boolean): void {
  const available = getAvailableThinkingLevels(ctx.model);
  if (!available.includes(level)) {
    ctx.ui.notify(
      `Model ${modelName(ctx.model)} does not support ${level}. Available: ${formatAvailableLevels(ctx.model)}`,
      "error",
    );
    return;
  }

  const before = pi.getThinkingLevel();
  pi.setThinkingLevel(toThinkingLevel(level));
  const after = pi.getThinkingLevel();
  const appliesNow = ctx.isIdle();
  updateEffortUi(ctx, after, fastMode, appliesNow);
  const suffix = appliesNow ? "" : " (applies next prompt)";
  ctx.ui.notify(before === after ? `Effort already ${after}` : `Effort changed: ${before} -> ${after}${suffix}`, "info");
}

export default function effortExtension(pi: ExtensionAPI): void {
  const settingsPath = join(getAgentDir(), "settings.json");

  let currentModel: EffortModel | null = null;
  let activeRunEffort: string | undefined;
  let fastMode = getFastMode(settingsPath);

  function refreshFastMode(): boolean {
    fastMode = getFastMode(settingsPath);
    return fastMode;
  }

  function syncEffortUi(ctx: ExtensionContext, current: string = pi.getThinkingLevel()): string {
    updateEffortUi(ctx, current, refreshFastMode());
    return current;
  }

  pi.registerFlag("effort", {
    description: "Initial thinking effort level (min|max|minimal|low|medium|high|xhigh)",
    type: "string",
  });

  pi.on("before_provider_request", (event) => {
    if (!fastMode) return undefined;

    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }

    const body = payload as Record<string, unknown>;
    const model = typeof body.model === "string" ? body.model : "";
    if (!isFastModelId(model) || body.service_tier !== undefined) {
      return undefined;
    }

    return {
      ...body,
      service_tier: "priority",
    };
  });

  pi.registerShortcut("ctrl+shift+e", {
    description: "Cycle effort level",
    handler: (ctx) => {
      const current = pi.getThinkingLevel();
      const next = cycleLevel(current, ctx.model);
      if (!next) {
        ctx.ui.notify("Thinking not available for this model", "warning");
        return;
      }

      pi.setThinkingLevel(toThinkingLevel(next));
      const after = pi.getThinkingLevel();
      const appliesNow = ctx.isIdle();
      updateEffortUi(ctx, after, refreshFastMode(), appliesNow);
      const suffix = appliesNow ? "" : " (applies next prompt)";
      ctx.ui.notify(`Effort: ${current} -> ${after}${suffix}`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    currentModel = ctx.model ?? null;
    syncEffortUi(ctx);

    const flagValue = pi.getFlag("effort");
    if (typeof flagValue !== "string" || !flagValue) return;

    const requested = flagValue.trim();
    const isKnownRequest = USER_LEVELS.includes(requested as any) || isEffortAlias(requested);
    if (!isKnownRequest) {
      ctx.ui.notify(`--effort ${flagValue}: unknown effort level`, "warning");
      return;
    }

    const resolved = resolveEffortLevel(requested as EffortLevel | "min" | "max", ctx.model);
    if (!resolved) {
      ctx.ui.notify(`--effort ${flagValue}: thinking not available for ${modelName(ctx.model)}`, "warning");
      return;
    }

    const available = getAvailableThinkingLevels(ctx.model);
    if (!available.includes(resolved)) {
      ctx.ui.notify(
        `--effort ${flagValue}: not supported by ${modelName(ctx.model)}. Available: ${formatAvailableLevels(ctx.model)}`,
        "warning",
      );
      return;
    }

    pi.setThinkingLevel(toThinkingLevel(resolved));
    syncEffortUi(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    currentModel = event.model;
    const visibleEffort = ctx.isIdle() ? pi.getThinkingLevel() : activeRunEffort ?? pi.getThinkingLevel();
    syncEffortUi(ctx, visibleEffort);
  });

  pi.on("thinking_level_select", (event, ctx) => {
    const visibleEffort = ctx.isIdle() ? event.level : activeRunEffort ?? event.level;
    syncEffortUi(ctx, visibleEffort);
  });

  pi.on("agent_start", (_event, ctx) => {
    currentModel = ctx.model ?? currentModel;
    activeRunEffort = pi.getThinkingLevel();
    syncEffortUi(ctx, activeRunEffort);
  });

  pi.on("turn_start", (_event, ctx) => {
    currentModel = ctx.model ?? currentModel;
    activeRunEffort ??= pi.getThinkingLevel();
    syncEffortUi(ctx, activeRunEffort);
  });

  pi.on("agent_end", (_event, ctx) => {
    activeRunEffort = undefined;
    syncEffortUi(ctx);
  });

  function setFastMode(ctx: ExtensionContext, enabled: boolean): void {
    try {
      writeFastMode(settingsPath, enabled);
    } catch (error) {
      ctx.ui.notify(`Failed to update fast mode: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }

    fastMode = enabled;
    syncEffortUi(ctx);
    ctx.ui.notify(`Fast mode ${fastMode ? "enabled" : "disabled"}.`, "info");
  }

  pi.registerCommand("effort", {
    description: "Set thinking effort (min/max adapt per model)",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trimStart();
      const tokens = value.split(/\s+/).filter(Boolean);
      const trailingSpace = /\s$/.test(value);
      const modelLevels = getUserFacingLevels(currentModel);
      const options = modelLevels.length > 0 ? ["min", ...modelLevels, "max"] : [];

      if (tokens.length === 0) {
        return options.map((value) => ({ value, label: value }));
      }

      if (tokens.length === 1 && !trailingSpace) {
        return options.filter((option) => option.startsWith(tokens[0])).map((value) => ({ value, label: value }));
      }

      return null;
    },
    handler: async (args, ctx) => {
      let command;
      try {
        command = parseEffortCommand(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      switch (command.kind) {
        case "set-session":
          applySessionLevel(pi, ctx, command.level, refreshFastMode());
          return;
        case "set-min": {
          const resolved = resolveMinLevel(ctx.model);
          if (!resolved) {
            ctx.ui.notify(`Thinking not available for ${modelName(ctx.model)}`, "error");
            return;
          }
          applySessionLevel(pi, ctx, resolved, refreshFastMode());
          return;
        }
        case "set-max": {
          const resolved = resolveMaxLevel(ctx.model);
          if (!resolved) {
            ctx.ui.notify(`Thinking not available for ${modelName(ctx.model)}`, "error");
            return;
          }
          applySessionLevel(pi, ctx, resolved, refreshFastMode());
          return;
        }
      }
    },
  });

  pi.registerCommand("fast", {
    description: "Set fast mode",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trimStart();
      const tokens = value.split(/\s+/).filter(Boolean);
      const trailingSpace = /\s$/.test(value);
      const firstPrefix = trailingSpace ? "" : tokens[0] ?? "";
      const options = ["on", "off"];

      if (tokens.length === 0 || (tokens.length === 1 && !trailingSpace)) {
        return options.filter((option) => option.startsWith(firstPrefix)).map((value) => ({ value, label: value }));
      }

      return null;
    },
    handler: async (args, ctx) => {
      let command;
      try {
        command = parseFastCommand(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      const enabled = command.kind === "fast-toggle" ? !refreshFastMode() : command.enabled;
      setFastMode(ctx, enabled);
    },
  });
}
