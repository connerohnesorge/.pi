/**
 * `/workflows-models` command handler.
 *
 * Uses Pi's built-in `ctx.ui.select()`, `ctx.ui.confirm()`, and `ctx.ui.notify()`
 * to let users view and manage model tier configuration for workflows.
 *
 * Model selection draws from the host session's shared model registry so users
 * see every provider Pi can reach, including extension-registered providers such
 * as `ollama-cloud`.
 *
 * Each tier holds exactly one model spec string.
 * When editing a tier, a single-select picker is used (like Pi's `/model`).
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { listAvailableModelSpecs } from "./agent.ts";
import {
  buildDefaultTierConfig,
  loadModelTierConfig,
  saveModelTierConfig,
  sortedTierNames,
} from "./model-tier-config.ts";

/**
 * Register the `/workflows-models` command with Pi.
 */
export function registerWorkflowModelsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("workflows-models", {
    description: "View and edit model tiers used by workflows (small/medium/big)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await handleWorkflowModels(ctx);
    },
  });
}


async function handleWorkflowModels(ctx: ExtensionCommandContext): Promise<void> {
  const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  let config = loadModelTierConfig() ?? buildDefaultTierConfig(currentModel, listAvailableModelSpecs());
  let dirty = false;
  const markFresh = (cfg: typeof config) => {
    config = cfg;
    dirty = true;
  };

  for (;;) {
    const choice = await ctx.ui.select("Model tier configuration", modelTierMenuOptions(config, dirty));
    if (!choice) break;

    const tierChanged = await maybeEditTier(ctx, config, choice, markFresh);
    if (!tierChanged) await maybeResetDefaults(ctx, choice, currentModel, markFresh);
    if (isExitChoice(choice)) {
      saveIfRequested(ctx, choice, config);
      break;
    }
  }
}

function modelTierMenuOptions(config: ReturnType<typeof buildDefaultTierConfig>, dirty: boolean): string[] {
  const tiers = sortedTierNames(config);
  return [
    "─".repeat(30),
    ...tiers.map((name) => `${name} tier → ${config.tiers[name]}`),
    "─".repeat(30),
    "Reset to defaults",
    dirty ? "Save and exit" : "Exit",
  ];
}

async function maybeEditTier(
  ctx: ExtensionCommandContext,
  config: ReturnType<typeof buildDefaultTierConfig>,
  choice: string,
  markFresh: (cfg: ReturnType<typeof buildDefaultTierConfig>) => void,
): Promise<boolean> {
  const tierName = sortedTierNames(config).find((name) => choice.startsWith(`${name} tier →`));
  if (!tierName) return false;
  const updatedTiers = await editSingleTier(ctx, config.tiers, tierName);
  if (updatedTiers !== null) markFresh({ ...config, tiers: updatedTiers });
  return true;
}

async function maybeResetDefaults(
  ctx: ExtensionCommandContext,
  choice: string,
  currentModel: string | undefined,
  markFresh: (cfg: ReturnType<typeof buildDefaultTierConfig>) => void,
): Promise<void> {
  if (choice !== "Reset to defaults") return;
  const confirmed = await ctx.ui.confirm("Reset model tiers", "This will reset tiers from your available model list. Continue?");
  if (!confirmed) return;
  markFresh(buildDefaultTierConfig(currentModel, listAvailableModelSpecs()));
  ctx.ui.notify("Tiers reset to defaults. Use 'Save and exit' to persist.", "info");
}

function isExitChoice(choice: string): boolean {
  return choice === "Save and exit" || choice === "Exit";
}

function saveIfRequested(
  ctx: ExtensionCommandContext,
  choice: string,
  config: ReturnType<typeof buildDefaultTierConfig>,
): void {
  if (choice !== "Save and exit") return;
  saveModelTierConfig(config);
  ctx.ui.notify("Model tiers saved.", "info");
}

/**
 * Interactive editor for a single tier — scrollable model picker.
 *
 * Uses `ctx.ui.custom()` with Pi TUI's `SelectList` for proper
 * scrollable list with limited visible rows (like `/advisor`).
 *
 * The currently selected model is shown in the dialog title.
 * User scrolls with ↑↓, selects with Enter, cancels with Escape.
 *
 * Returns the updated tiers object, or null if nothing changed.
 */
export async function editSingleTier(
  ctx: ExtensionCommandContext,
  tiers: Record<string, string>,
  tierName: string,
): Promise<Record<string, string> | null> {
  const available = listAvailableModelSpecs(ctx.modelRegistry);
  const current = tiers[tierName];

  // Build SelectItems: all available models as scrollable list
  const items: SelectItem[] = available.map((m) => ({ value: m, label: m }));

  const result = await ctx.ui.custom<string | null>((tui: TUI, theme: Theme, _keybindings, done) => {
    const container = new Container();

    // Title showing current model
    const titleText = current
      ? `Pick a model for "${tierName}" (current: ${current})`
      : `Pick a model for "${tierName}"`;
    container.addChild(new Text(theme.fg("accent", titleText), 1, 0));
    container.addChild(new Spacer(1));

    // SelectList theme
    const selectTheme: SelectListTheme = {
      selectedPrefix: (t: string) => theme.bg("selectedBg", theme.fg("accent", t)),
      selectedText: (t: string) => theme.bg("selectedBg", theme.bold(t)),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    };

    const selectList = new SelectList(items, 12, selectTheme);

    // Preselect the current model
    if (current) {
      const idx = items.findIndex((i) => i.value === current);
      if (idx >= 0) selectList.setSelectedIndex(idx);
    }

    // Wire up callbacks
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);

    container.addChild(selectList);
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate  enter select  esc cancel"), 1, 0));

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  if (!result || result === current) return null;

  ctx.ui.notify(`"${tierName}" tier → ${result}`, "info");
  return { ...tiers, [tierName]: result };
}
