import { getSettingsListTheme, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { SettingsList, truncateToWidth, visibleWidth, type SettingItem } from "@earendil-works/pi-tui";
import { toOnOff } from "./boolean-format.js";
import {
	DEFAULT_RTK_INTEGRATION_CONFIG,
	type RtkIntegrationConfig,
	type RtkIntegrationController,
	type RuntimeStatus,
} from "./types.js";

interface SettingValueSyncTarget {
	updateValue(id: string, value: string): void;
}

interface SettingsTab {
	label: string;
	settings: SettingItem[];
}

interface RtkSettingsOverlayOptions {
	title: string;
	tabs: SettingsTab[];
	activeTabIndex: number;
	onChange: (id: string, value: string) => void;
	onClose: () => void;
	helpText: string;
	enableSearch: boolean;
}

export class RtkSettingsOverlay implements SettingValueSyncTarget {
	private readonly tabLists: SettingsList[];
	private activeTabIndex: number;

	constructor(
		private readonly options: RtkSettingsOverlayOptions,
		private readonly theme: Theme,
	) {
		this.tabLists = options.tabs.map((tab) => this.createSettingsList(tab.settings));
		this.activeTabIndex = this.normalizeActiveTabIndex(options.activeTabIndex);
	}

	updateValue(id: string, value: string): void {
		for (const list of this.tabLists) {
			list.updateValue(id, value);
		}
	}

	invalidate(): void {
		for (const list of this.tabLists) {
			list.invalidate();
		}
	}

	handleInput(data: string): void {
		if (data === "\x1b[D") {
			this.switchTab(-1);
			return;
		}
		if (data === "\x1b[C") {
			this.switchTab(1);
			return;
		}

		this.activeSettingsList().handleInput(data);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines = [
			truncateToWidth(this.theme.fg("accent", this.theme.bold(this.options.title)), safeWidth),
			"",
			this.renderTabBar(safeWidth),
			"",
			...this.activeSettingsList().render(safeWidth),
			this.theme.fg("border", "─".repeat(safeWidth)),
			truncateToWidth(this.theme.fg("dim", this.options.helpText), safeWidth),
		];
		return lines.map((line) => truncateToWidth(line, safeWidth, ""));
	}

	private createSettingsList(settings: SettingItem[]): SettingsList {
		return new SettingsList(
			settings,
			Math.min(Math.max(settings.length + 2, 6), 18),
			getSettingsListTheme(),
			this.options.onChange,
			this.options.onClose,
			{ enableSearch: this.options.enableSearch },
		);
	}

	private activeSettingsList(): SettingsList {
		return this.tabLists[this.activeTabIndex] ?? this.tabLists[0]!;
	}

	private switchTab(direction: number): void {
		this.activeTabIndex = this.normalizeActiveTabIndex(this.activeTabIndex + direction);
	}

	private normalizeActiveTabIndex(index: number): number {
		const count = this.tabLists.length;
		if (count === 0) return 0;
		const normalized = Number.isFinite(index) ? Math.floor(index) : 0;
		return ((normalized % count) + count) % count;
	}

	private renderTabBar(width: number): string {
		const parts = this.options.tabs.map((tab, index) => {
			const text = index === this.activeTabIndex ? `[ ${tab.label} ]` : `  ${tab.label}  `;
			return this.theme.fg(index === this.activeTabIndex ? "accent" : "muted", text);
		});
		let rendered = "";
		for (const part of parts) {
			if (visibleWidth(rendered + part) > width) break;
			rendered += part;
		}
		return truncateToWidth(rendered, width, "");
	}
}

const ON_OFF = ["on", "off"];
const MODE_VALUES = ["rewrite", "suggest"];
const COMPACTION_PRESET_VALUES = ["off", "balanced", "conservative", "aggressive", "custom"] as const;
type CompactionPreset = (typeof COMPACTION_PRESET_VALUES)[number];
const RTK_USAGE_TEXT =
	"Usage: /rtk [show|path|verify|stats|clear-stats|reset|help] (or run /rtk with no args to open settings modal)";
const SETTINGS_TAB_DEFINITIONS = [
	{
		label: "General",
		settingIds: ["enabled", "mode", "showRewriteNotifications", "guardWhenRtkMissing"],
	},
	{
		label: "Output",
		settingIds: ["outputCompactionPreset", "outputTrackSavings"],
	},
] as const;

function buildTabbedSettingGroups(settings: SettingItem[]): Array<{ label: string; settings: SettingItem[] }> {
	const byId = new Map(settings.map((setting) => [setting.id, setting]));
	const assignedIds = new Set<string>();

	const tabs = SETTINGS_TAB_DEFINITIONS.map(({ label, settingIds }) => ({
		label,
		settings: settingIds.map((id) => {
			const setting = byId.get(id);
			if (!setting) {
				throw new Error(`Missing setting item for tab '${label}': ${id}`);
			}
			if (assignedIds.has(id)) {
				throw new Error(`Setting item assigned to multiple tabs: ${id}`);
			}
			assignedIds.add(id);
			return setting;
		}),
	}));

	const unassignedIds = settings.map((setting) => setting.id).filter((id) => !assignedIds.has(id));
	if (unassignedIds.length > 0) {
		throw new Error(`Unassigned setting items: ${unassignedIds.join(", ")}`);
	}

	return tabs;
}

function cloneOutputCompactionConfig(
	config: RtkIntegrationConfig["outputCompaction"],
): RtkIntegrationConfig["outputCompaction"] {
	return {
		...config,
		readCompaction: { ...config.readCompaction },
		truncate: { ...config.truncate },
		smartTruncate: { ...config.smartTruncate },
	};
}

function outputCompactionPresetConfig(preset: Exclude<CompactionPreset, "custom">): RtkIntegrationConfig["outputCompaction"] {
	const base = cloneOutputCompactionConfig(DEFAULT_RTK_INTEGRATION_CONFIG.outputCompaction);
	switch (preset) {
		case "off":
			return { ...base, enabled: false };
		case "conservative":
			return {
				...base,
				enabled: true,
				readCompaction: { enabled: false },
				truncate: { enabled: true, maxChars: 20_000 },
				sourceCodeFilteringEnabled: false,
				sourceCodeFiltering: "none",
				smartTruncate: { enabled: false, maxLines: base.smartTruncate.maxLines },
			};
		case "aggressive":
			return {
				...base,
				enabled: true,
				readCompaction: { enabled: true },
				truncate: { enabled: true, maxChars: 8_000 },
				sourceCodeFilteringEnabled: true,
				preserveExactSkillReads: true,
				sourceCodeFiltering: "aggressive",
				smartTruncate: { enabled: true, maxLines: 160 },
			};
		case "balanced":
			return base;
	}
}

function samePresetShape(
	left: RtkIntegrationConfig["outputCompaction"],
	right: RtkIntegrationConfig["outputCompaction"],
): boolean {
	const normalize = (value: RtkIntegrationConfig["outputCompaction"]) => {
		const clone = cloneOutputCompactionConfig(value);
		clone.trackSavings = false;
		return JSON.stringify(clone);
	};
	return normalize(left) === normalize(right);
}

function inferCompactionPreset(config: RtkIntegrationConfig): CompactionPreset {
	const current = config.outputCompaction;
	for (const preset of ["off", "balanced", "conservative", "aggressive"] as const) {
		if (samePresetShape(current, outputCompactionPresetConfig(preset))) return preset;
	}
	return "custom";
}

function applyCompactionPreset(config: RtkIntegrationConfig, value: string): RtkIntegrationConfig {
	const preset = COMPACTION_PRESET_VALUES.includes(value as CompactionPreset) ? (value as CompactionPreset) : "custom";
	if (preset === "custom") return config;
	return {
		...config,
		outputCompaction: {
			...outputCompactionPresetConfig(preset),
			trackSavings: config.outputCompaction.trackSavings,
		},
	};
}

function summarizeRuntimeStatus(runtimeStatus: RuntimeStatus): string {
	const runtime = runtimeStatus.rtkAvailable
		? "rtk=available"
		: `rtk=missing${runtimeStatus.lastError ? ` (${runtimeStatus.lastError})` : ""}`;
	const executable = runtimeStatus.rtkExecutablePath
		? `, rtkPath=${runtimeStatus.rtkExecutablePath}`
		: runtimeStatus.rtkExecutableResolutionWarning
			? `, rtkPath=unresolved (${runtimeStatus.rtkExecutableResolutionWarning})`
			: "";

	return `${runtime}${executable}`;
}

function summarizeConfig(config: RtkIntegrationConfig, runtimeStatus: RuntimeStatus): string {
	return `enabled=${config.enabled}, mode=${config.mode}, rewriteSource=rtk, rewriteNotice=${config.showRewriteNotifications}, compactionPreset=${inferCompactionPreset(config)}, savings=${config.outputCompaction.trackSavings}, ${summarizeRuntimeStatus(runtimeStatus)}`;
}

function buildSettingItems(config: RtkIntegrationConfig): SettingItem[] {
	return [
		{
			id: "enabled",
			label: "RTK integration enabled",
			description: "Master switch for rewrite, suggestions, and output compaction",
			currentValue: toOnOff(config.enabled),
			values: ON_OFF,
		},
		{
			id: "mode",
			label: "Rewrite mode",
			description: "rewrite = auto-rewrite bash commands, suggest = notify only",
			currentValue: config.mode,
			values: MODE_VALUES,
		},
		{
			id: "showRewriteNotifications",
			label: "Show rewrite notifications",
			description: "Show 'RTK rewrite: old -> new' notice in TUI",
			currentValue: toOnOff(config.showRewriteNotifications),
			values: ON_OFF,
		},
		{
			id: "guardWhenRtkMissing",
			label: "Guard when rtk missing",
			description: "If on, raw commands run unchanged when rtk binary is unavailable",
			currentValue: toOnOff(config.guardWhenRtkMissing),
			values: ON_OFF,
		},
		{
			id: "outputCompactionPreset",
			label: "Output compaction preset",
			description: "Pick one profile instead of tuning individual compaction techniques",
			currentValue: inferCompactionPreset(config),
			values: [...COMPACTION_PRESET_VALUES],
		},
		{
			id: "outputTrackSavings",
			label: "Track output savings",
			description: "Collect in-session compaction metrics for /rtk stats",
			currentValue: toOnOff(config.outputCompaction.trackSavings),
			values: ON_OFF,
		},
	];
}

function applySetting(config: RtkIntegrationConfig, id: string, value: string): RtkIntegrationConfig {
	switch (id) {
		case "enabled":
			return { ...config, enabled: value === "on" };
		case "mode":
			return { ...config, mode: value === "suggest" ? "suggest" : "rewrite" };
		case "showRewriteNotifications":
			return { ...config, showRewriteNotifications: value === "on" };
		case "guardWhenRtkMissing":
			return { ...config, guardWhenRtkMissing: value === "on" };
		case "outputCompactionPreset":
			return applyCompactionPreset(config, value);
		case "outputTrackSavings":
			return {
				...config,
				outputCompaction: {
					...config.outputCompaction,
					trackSavings: value === "on",
				},
			};
		default:
			return config;
	}
}

function syncSettingValues(settingsList: SettingValueSyncTarget, config: RtkIntegrationConfig): void {
	settingsList.updateValue("enabled", toOnOff(config.enabled));
	settingsList.updateValue("mode", config.mode);
	settingsList.updateValue("showRewriteNotifications", toOnOff(config.showRewriteNotifications));
	settingsList.updateValue("guardWhenRtkMissing", toOnOff(config.guardWhenRtkMissing));
	settingsList.updateValue("outputCompactionPreset", inferCompactionPreset(config));
	settingsList.updateValue("outputTrackSavings", toOnOff(config.outputCompaction.trackSavings));
}

async function openSettingsModal(ctx: ExtensionCommandContext, controller: RtkIntegrationController): Promise<void> {
	const overlayOptions = { anchor: "center" as const, width: 86, maxHeight: "85%" as const, margin: 1 };

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			let current = controller.getConfig();
			let settingsOverlay: RtkSettingsOverlay | null = null;
			const allSettings = buildSettingItems(current);
			const tabs = buildTabbedSettingGroups(allSettings);

			settingsOverlay = new RtkSettingsOverlay(
				{
					title: "Pi RTK Optimizer",
					tabs,
					activeTabIndex: 0,
					onChange: (id, newValue) => {
						current = applySetting(current, id, newValue);
						controller.setConfig(current, ctx);
						current = controller.getConfig();
						if (settingsOverlay) {
							syncSettingValues(settingsOverlay, current);
						}
					},
					onClose: () => done(),
					helpText: `Config: ${controller.getConfigPath()}`,
					enableSearch: true,
				},
				theme,
			);

			return {
				render(width: number) {
					return settingsOverlay.render(width);
				},
				invalidate() {
					settingsOverlay.invalidate();
				},
				handleInput(data: string) {
					settingsOverlay.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions },
	);
}

async function handleArgs(
	args: string,
	ctx: ExtensionCommandContext,
	controller: RtkIntegrationController,
): Promise<boolean> {
	const normalized = (args ?? "").trim().toLowerCase();
	if (!normalized) {
		return false;
	}

	if (normalized === "help") {
		ctx.ui.notify(RTK_USAGE_TEXT, "info");
		return true;
	}

	if (normalized === "show") {
		ctx.ui.notify(`rtk: ${summarizeConfig(controller.getConfig(), controller.getRuntimeStatus())}`, "info");
		return true;
	}

	if (normalized === "path") {
		ctx.ui.notify(`rtk config: ${controller.getConfigPath()}`, "info");
		return true;
	}

	if (normalized === "verify") {
		const runtimeStatus = await controller.refreshRuntimeStatus();
		if (runtimeStatus.rtkAvailable) {
			const pathDetail = runtimeStatus.rtkExecutablePath ? ` at ${runtimeStatus.rtkExecutablePath}` : "";
			ctx.ui.notify(`RTK binary is available${pathDetail}.`, "info");
		} else {
			ctx.ui.notify(
				`RTK binary is not available${runtimeStatus.lastError ? `: ${runtimeStatus.lastError}` : ""}.`,
				"warning",
			);
		}
		return true;
	}

	if (normalized === "stats") {
		ctx.ui.notify(controller.getMetricsSummary(), "info");
		return true;
	}

	if (normalized === "clear-stats") {
		controller.clearMetrics();
		ctx.ui.notify("RTK metrics cleared.", "info");
		return true;
	}

	if (normalized === "reset") {
		controller.setConfig({ ...DEFAULT_RTK_INTEGRATION_CONFIG }, ctx);
		ctx.ui.notify("RTK integration settings reset to defaults.", "info");
		return true;
	}

	ctx.ui.notify(RTK_USAGE_TEXT, "warning");
	return true;
}

export async function handleRtkIntegrationCommand(
	args: string,
	ctx: ExtensionCommandContext,
	controller: RtkIntegrationController,
): Promise<void> {
	if (await handleArgs(args, ctx, controller)) {
		return;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify("/rtk requires interactive TUI mode.", "warning");
		return;
	}

	await openSettingsModal(ctx, controller);
}
