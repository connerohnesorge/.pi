// fallow-ignore-file code-duplication
/**
 * Chain Clarification TUI Component
 *
 * Shows templates and resolved behaviors for each step in a chain.
 * Supports runtime editing of templates, output paths, reads lists, and progress toggle.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../../agents/agents.ts";
import type { ModelInfo, ThinkingLevel } from "../../shared/model-info.ts";
import type { ResolvedStepBehavior } from "../../shared/settings.ts";
import { splitThinkingSuffix } from "../shared/model-fallback.ts";
import {
	type BehaviorOverride,
	ChainClarifyModel,
	type ChainClarifyInputAction,
	type ChainClarifyResult,
	type ClarifyMode,
	type EditMode,
	ensureCursorVisible,
	getCursorDisplayPos,
	type SkillInfo,
	type TextEditorState,
	wrapText,
} from "./chain-clarify-model.ts";

export type { BehaviorOverride, ChainClarifyResult, ClarifyMode } from "./chain-clarify-model.ts";

function renderWithCursor(text: string, cursorPos: number): string {
	const before = text.slice(0, cursorPos);
	const cursorChar = text[cursorPos] ?? " ";
	const after = text.slice(cursorPos + 1);
	return `${before}\x1b[7m${cursorChar}\x1b[27m${after}`;
}

function renderEditor(state: TextEditorState, width: number, viewportHeight: number): string[] {
	const { lines: wrapped, starts } = wrapText(state.buffer, width);
	const cursorPos = getCursorDisplayPos(state.cursor, starts);
	const lines: string[] = [];
	for (let i = 0; i < viewportHeight; i++) {
		const lineIdx = state.viewportOffset + i;
		let content = lineIdx < wrapped.length ? wrapped[lineIdx] ?? "" : "";
		if (lineIdx === cursorPos.line) content = renderWithCursor(content, cursorPos.col);
		lines.push(content);
	}
	return lines;
}

/**
 * TUI component for chain clarification.
 * Factory signature matches ctx.ui.custom: (tui, theme, kb, done) => Component
 */
export class ChainClarifyComponent implements Component {
	readonly width = 84;

	private readonly model: ChainClarifyModel;
	private readonly EDIT_VIEWPORT_HEIGHT = 12;
	private readonly MODEL_SELECTOR_HEIGHT = 10;
	private noticeMessage: { text: string; type: "info" | "error" } | null = null;
	private noticeMessageTimer: ReturnType<typeof setTimeout> | null = null;
	private tui: TUI;
	private theme: Theme;
	private done: (result: ChainClarifyResult) => void;

	get selectedStep(): number { return this.model.selectedStep; }
	set selectedStep(value: number) { this.model.selectedStep = value; }
	get editingStep(): number | null { return this.model.editingStep; }
	set editingStep(value: number | null) { this.model.editingStep = value; }
	get editMode(): EditMode { return this.model.editMode; }
	set editMode(value: EditMode) { this.model.editMode = value; }
	get editState(): TextEditorState { return this.model.editState; }
	set editState(value: TextEditorState) { this.model.editState = value; }
	get behaviorOverrides(): Map<number, BehaviorOverride> { return this.model.behaviorOverrides; }
	get modelSearchQuery(): string { return this.model.modelSearchQuery; }
	set modelSearchQuery(value: string) { this.model.modelSearchQuery = value; }
	get modelSelectedIndex(): number { return this.model.modelSelectedIndex; }
	set modelSelectedIndex(value: number) { this.model.modelSelectedIndex = value; }
	get filteredModels(): ModelInfo[] { return this.model.filteredModels; }
	set filteredModels(value: ModelInfo[]) { this.model.filteredModels = value; }
	get thinkingSelectedIndex(): number { return this.model.thinkingSelectedIndex; }
	set thinkingSelectedIndex(value: number) { this.model.thinkingSelectedIndex = value; }
	get skillSearchQuery(): string { return this.model.skillSearchQuery; }
	set skillSearchQuery(value: string) { this.model.skillSearchQuery = value; }
	get skillSelectedNames(): Set<string> { return this.model.skillSelectedNames; }
	get skillCursorIndex(): number { return this.model.skillCursorIndex; }
	set skillCursorIndex(value: number) { this.model.skillCursorIndex = value; }
	get filteredSkills(): SkillInfo[] { return this.model.filteredSkills; }
	set filteredSkills(value: SkillInfo[]) { this.model.filteredSkills = value; }
	get runInBackground(): boolean { return this.model.runInBackground; }
	set runInBackground(value: boolean) { this.model.runInBackground = value; }
	get agentConfigs(): AgentConfig[] { return this.model.agentConfigs; }
	get templates(): string[] { return this.model.templates; }
	get originalTask(): string { return this.model.originalTask; }
	get chainDir(): string | undefined { return this.model.chainDir; }
	get resolvedBehaviors(): ResolvedStepBehavior[] { return this.model.resolvedBehaviors; }
	get availableModels(): ModelInfo[] { return this.model.availableModels; }
	get preferredProvider(): string | undefined { return this.model.preferredProvider; }
	get availableSkills(): SkillInfo[] { return this.model.availableSkills; }
	get mode(): ClarifyMode { return this.model.mode; }

	constructor(
		tui: TUI,
		theme: Theme,
		agentConfigs: AgentConfig[],
		templates: string[],
		originalTask: string,
		chainDir: string | undefined,
		resolvedBehaviors: ResolvedStepBehavior[],
		availableModels: ModelInfo[],
		preferredProvider: string | undefined,
		availableSkills: Array<{ name: string; source: string; description?: string }>,
		done: (result: ChainClarifyResult) => void,
		mode: ClarifyMode = 'chain',
	) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.model = new ChainClarifyModel({
			agentConfigs,
			templates,
			originalTask,
			chainDir,
			resolvedBehaviors,
			availableModels,
			preferredProvider,
			availableSkills,
			mode,
		});
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Helper methods for rendering
	// ─────────────────────────────────────────────────────────────────────────────

	/** Pad string to specified visible width */
	private pad(s: string, len: number): string {
		const vis = visibleWidth(s);
		return s + " ".repeat(Math.max(0, len - vis));
	}

	/** Create a row with border characters */
	private row(content: string): string {
		const innerW = this.width - 2;
		return this.theme.fg("border", "│") + this.pad(content, innerW) + this.theme.fg("border", "│");
	}

	/** Render centered header line with border */
	private renderHeader(text: string): string {
		const innerW = this.width - 2;
		const padLen = Math.max(0, innerW - visibleWidth(text));
		const padLeft = Math.floor(padLen / 2);
		const padRight = padLen - padLeft;
		return (
			this.theme.fg("border", "╭" + "─".repeat(padLeft)) +
			this.theme.fg("accent", text) +
			this.theme.fg("border", "─".repeat(padRight) + "╮")
		);
	}

	/** Render centered footer line with border */
	private renderFooter(text: string): string {
		const innerW = this.width - 2;
		const padLen = Math.max(0, innerW - visibleWidth(text));
		const padLeft = Math.floor(padLen / 2);
		const padRight = padLen - padLeft;
		return (
			this.theme.fg("border", "╰" + "─".repeat(padLeft)) +
			this.theme.fg("dim", text) +
			this.theme.fg("border", "─".repeat(padRight) + "╯")
		);
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Full edit mode methods
	// ─────────────────────────────────────────────────────────────────────────────

	/** Render the full-edit takeover view */
	private renderFullEditMode(): string[] {
		const innerW = this.width - 2;
		const textWidth = innerW - 2; // 1 char padding on each side
		const lines: string[] = [];

		const { lines: wrapped, starts } = wrapText(this.editState.buffer, textWidth);
		const cursorPos = getCursorDisplayPos(this.editState.cursor, starts);
		this.editState = {
			...this.editState,
			viewportOffset: ensureCursorVisible(
				cursorPos.line,
				this.EDIT_VIEWPORT_HEIGHT,
				this.editState.viewportOffset,
			),
		};

		// Header (truncate agent name to prevent overflow)
		const fieldName = this.editMode === "template" ? "task" : this.editMode;
		const rawAgentName = this.agentConfigs[this.editingStep!]?.name ?? "unknown";
		const maxAgentLen = innerW - 30; // Reserve space for " Editing X (Step/Task N: ) "
		const agentName = rawAgentName.length > maxAgentLen
			? rawAgentName.slice(0, maxAgentLen - 1) + "…"
			: rawAgentName;
		// Use mode-appropriate terminology
		const stepLabel = this.mode === 'single' 
			? agentName 
			: this.mode === 'parallel' 
				? `Task ${this.editingStep! + 1}: ${agentName}` 
				: `Step ${this.editingStep! + 1}: ${agentName}`;
		const headerText = ` Editing ${fieldName} (${stepLabel}) `;
		lines.push(this.renderHeader(headerText));
		lines.push(this.row(""));

		const editorLines = renderEditor(this.editState, textWidth, this.EDIT_VIEWPORT_HEIGHT);
		for (const line of editorLines) {
			lines.push(this.row(` ${line}`));
		}

		const linesBelow = wrapped.length - this.editState.viewportOffset - this.EDIT_VIEWPORT_HEIGHT;
		const hasMore = linesBelow > 0;
		const hasLess = this.editState.viewportOffset > 0;
		let scrollInfo = "";
		if (hasLess) scrollInfo += "↑";
		if (hasMore) scrollInfo += `↓ ${linesBelow}+`;

		lines.push(this.row(""));

		const footerText = scrollInfo
			? ` [Esc] Done • [Ctrl+C] Discard • ${scrollInfo} `
			: " [Esc] Done • [Ctrl+C] Discard ";
		lines.push(this.renderFooter(footerText));

		return lines;
	}

	// ─────────────────────────────────────────────────────────────────────────────
	// Behavior helpers
	// ─────────────────────────────────────────────────────────────────────────────

	/** Get effective behavior for a step (with user overrides applied) */
	getEffectiveBehavior(stepIndex: number): ResolvedStepBehavior {
		return this.model.getEffectiveBehavior(stepIndex);
	}

	/** Get the effective model for a step (override or agent default) */
	getEffectiveModel(stepIndex: number): string {
		return this.model.getEffectiveModel(stepIndex);
	}

	private showNotice(text: string, type: "info" | "error"): void {
		this.noticeMessage = { text, type };
		if (this.noticeMessageTimer) clearTimeout(this.noticeMessageTimer);
		this.noticeMessageTimer = setTimeout(() => {
			this.noticeMessage = null;
			this.noticeMessageTimer = null;
			this.tui.requestRender();
		}, 2000);
		this.tui.requestRender();
	}

	private applyInputAction(action: ChainClarifyInputAction): void {
		switch (action.kind) {
			case "confirm":
				this.done(action.result);
				return;
			case "cancel":
				this.done(action.result);
				return;
			case "notice":
				this.showNotice(action.text, action.noticeType);
				return;
			case "render":
				this.tui.requestRender();
				return;
			case "none":
				return;
		}
	}

	// TUI Component lifecycle method invoked through the Component interface.
	readonly handleInput = (data: string): void => {
		this.applyInputAction(this.model.handleInput(data, this.width - 4, this.EDIT_VIEWPORT_HEIGHT));
	};

	/** Enter model selector mode */
	enterModelSelector(): void {
		this.model.enterModelSelector();
		this.tui.requestRender();
	}

	handleModelSelectorInput(data: string): void {
		this.applyInputAction(this.model.handleModelSelectorInput(data));
	}

	private getAvailableThinkingLevels(stepIndex: number): ThinkingLevel[] {
		return this.model.getAvailableThinkingLevels(stepIndex);
	}

	/** Enter thinking level selector mode */
	enterThinkingSelector(): void {
		this.applyInputAction(this.model.enterThinkingSelector());
	}

	/** Apply thinking level to the current step's model */
	applyThinkingLevel(level: ThinkingLevel): void {
		this.model.applyThinkingLevel(level);
	}

	render(_width: number): string[] {
		if (this.editingStep !== null) {
			if (this.editMode === "model") {
				return this.renderModelSelector();
			}
			if (this.editMode === "thinking") {
				return this.renderThinkingSelector();
			}
			if (this.editMode === "skills") {
				return this.renderSkillSelector();
			}
			return this.renderFullEditMode();
		}
		// Mode-based navigation rendering
		switch (this.mode) {
			case 'single': return this.renderSingleMode();
			case 'parallel': return this.renderParallelMode();
			case 'chain': return this.renderChainMode();
		}
	}

	/** Render the model selector view */
	private renderModelSelector(): string[] {
		const th = this.theme;
		const lines: string[] = [];

		// Header (mode-aware terminology)
		const agentName = this.agentConfigs[this.editingStep!]?.name ?? "unknown";
		const stepLabel = this.mode === 'single' 
			? agentName 
			: this.mode === 'parallel' 
				? `Task ${this.editingStep! + 1}: ${agentName}` 
				: `Step ${this.editingStep! + 1}: ${agentName}`;
		const headerText = ` Select Model (${stepLabel}) `;
		lines.push(this.renderHeader(headerText));
		lines.push(this.row(""));

		const searchPrefix = th.fg("dim", "Search: ");
		const cursor = "\x1b[7m \x1b[27m"; // Reverse video space for cursor
		const searchDisplay = this.modelSearchQuery + cursor;
		lines.push(this.row(` ${searchPrefix}${searchDisplay}`));
		lines.push(this.row(""));

		const currentModel = this.getEffectiveModel(this.editingStep!);
		const currentModelBase = splitThinkingSuffix(currentModel).baseModel;
		const currentLabel = th.fg("dim", "Current: ");
		lines.push(this.row(` ${currentLabel}${th.fg("warning", currentModel)}`));
		lines.push(this.row(""));

		if (this.filteredModels.length === 0) {
			lines.push(this.row(` ${th.fg("dim", "No matching models")}`));
		} else {
			const maxVisible = this.MODEL_SELECTOR_HEIGHT;
			let startIdx = 0;

			if (this.filteredModels.length > maxVisible) {
				startIdx = Math.max(0, this.modelSelectedIndex - Math.floor(maxVisible / 2));
				startIdx = Math.min(startIdx, this.filteredModels.length - maxVisible);
			}

			const endIdx = Math.min(startIdx + maxVisible, this.filteredModels.length);

			if (startIdx > 0) {
				lines.push(this.row(` ${th.fg("dim", `  ↑ ${startIdx} more`)}`));
			}

			for (let i = startIdx; i < endIdx; i++) {
				const model = this.filteredModels[i]!;
				const isSelected = i === this.modelSelectedIndex;
				const isCurrent = model.fullId === currentModelBase || model.id === currentModelBase;
				const prefix = isSelected ? th.fg("accent", "→ ") : "  ";
				const modelText = isSelected ? th.fg("accent", model.id) : model.id;
				const providerBadge = th.fg("dim", ` [${model.provider}]`);
				const currentBadge = isCurrent ? th.fg("success", " current") : "";

				lines.push(this.row(` ${prefix}${modelText}${providerBadge}${currentBadge}`));
			}

			const remaining = this.filteredModels.length - endIdx;
			if (remaining > 0) {
				lines.push(this.row(` ${th.fg("dim", `  ↓ ${remaining} more`)}`));
			}
		}

		const contentLines = lines.length;
		const targetHeight = 18;
		for (let i = contentLines; i < targetHeight; i++) {
			lines.push(this.row(""));
		}

		const footerText = " [Enter] Select • [Esc] Cancel • Type to search ";
		lines.push(this.renderFooter(footerText));

		return lines;
	}

	/** Render the thinking level selector view */
	private renderThinkingSelector(): string[] {
		const th = this.theme;
		const lines: string[] = [];

		const agentName = this.agentConfigs[this.editingStep!]?.name ?? "unknown";
		const stepLabel = this.mode === 'single' 
			? agentName 
			: this.mode === 'parallel' 
				? `Task ${this.editingStep! + 1}: ${agentName}` 
				: `Step ${this.editingStep! + 1}: ${agentName}`;
		const headerText = ` Thinking Level (${stepLabel}) `;
		lines.push(this.renderHeader(headerText));
		lines.push(this.row(""));

		const currentModel = this.getEffectiveModel(this.editingStep!);
		const currentLabel = th.fg("dim", "Model: ");
		lines.push(this.row(` ${currentLabel}${th.fg("accent", currentModel)}`));
		lines.push(this.row(""));

		lines.push(this.row(` ${th.fg("dim", "Select thinking level (extended thinking budget):")}`));
		lines.push(this.row(""));

		const levelDescriptions: Record<ThinkingLevel, string> = {
			"off": "No extended thinking",
			"minimal": "Brief reasoning",
			"low": "Light reasoning",
			"medium": "Moderate reasoning",
			"high": "Deep reasoning",
			"xhigh": "Maximum reasoning (ultrathink)",
		};

		const levels = this.getAvailableThinkingLevels(this.editingStep!);
		if (levels.length === 0) {
			lines.push(this.row(` ${th.fg("dim", "No supported thinking levels")}`));
		} else {
			for (let i = 0; i < levels.length; i++) {
				const level = levels[i]!;
				const isSelected = i === this.thinkingSelectedIndex;
				const prefix = isSelected ? th.fg("accent", "→ ") : "  ";
				const levelText = isSelected ? th.fg("accent", level) : level;
				const desc = th.fg("dim", ` - ${levelDescriptions[level]}`);
				lines.push(this.row(` ${prefix}${levelText}${desc}`));
			}
		}

		const contentLines = lines.length;
		const targetHeight = 16;
		for (let i = contentLines; i < targetHeight; i++) {
			lines.push(this.row(""));
		}

		const footerText = levels.length === 0
			? " [Esc] Cancel "
			: " [Enter] Select • [Esc] Cancel • ↑↓ Navigate ";
		lines.push(this.renderFooter(footerText));

		return lines;
	}

	private renderSkillSelector(): string[] {
		const innerW = this.width - 2;
		const th = this.theme;
		const lines: string[] = [];

		const agentName = this.agentConfigs[this.editingStep!]?.name ?? "unknown";
		const stepLabel = this.mode === 'single'
			? agentName
			: this.mode === 'parallel'
				? `Task ${this.editingStep! + 1}: ${agentName}`
				: `Step ${this.editingStep! + 1}: ${agentName}`;
		lines.push(this.renderHeader(` Select Skills (${stepLabel}) `));
		lines.push(this.row(""));

		const cursor = "\x1b[7m \x1b[27m";
		lines.push(this.row(` ${th.fg("dim", "Search: ")}${this.skillSearchQuery}${cursor}`));
		lines.push(this.row(""));

		const selected = [...this.skillSelectedNames].join(", ") || th.fg("dim", "(none)");
		lines.push(this.row(` ${th.fg("dim", "Selected: ")}${truncateToWidth(selected, innerW - 12)}`));
		lines.push(this.row(""));

		const selectorHeight = 10;
		if (this.filteredSkills.length === 0) {
			lines.push(this.row(` ${th.fg("dim", "No matching skills")}`));
		} else {
			let startIdx = 0;
			if (this.filteredSkills.length > selectorHeight) {
				startIdx = Math.max(0, this.skillCursorIndex - Math.floor(selectorHeight / 2));
				startIdx = Math.min(startIdx, this.filteredSkills.length - selectorHeight);
			}
			const endIdx = Math.min(startIdx + selectorHeight, this.filteredSkills.length);

			if (startIdx > 0) {
				lines.push(this.row(` ${th.fg("dim", `  ↑ ${startIdx} more`)}`));
			}

			for (let i = startIdx; i < endIdx; i++) {
				const skill = this.filteredSkills[i]!;
				const isCursor = i === this.skillCursorIndex;
				const isSelected = this.skillSelectedNames.has(skill.name);

				const prefix = isCursor ? th.fg("accent", "→ ") : "  ";
				const checkbox = isSelected ? th.fg("success", "[x]") : "[ ]";
				const nameText = isCursor ? th.fg("accent", skill.name) : skill.name;
				const sourceBadge = th.fg("dim", ` [${skill.source}]`);
				const desc = skill.description
					? th.fg("dim", ` - ${truncateToWidth(skill.description, 25)}`)
					: "";

				lines.push(this.row(` ${prefix}${checkbox} ${nameText}${sourceBadge}${desc}`));
			}

			const remaining = this.filteredSkills.length - endIdx;
			if (remaining > 0) {
				lines.push(this.row(` ${th.fg("dim", `  ↓ ${remaining} more`)}`));
			}
		}

		const targetHeight = 18;
		for (let i = lines.length; i < targetHeight; i++) {
			lines.push(this.row(""));
		}

		lines.push(this.renderFooter(" [Enter] Confirm • [Space] Toggle • [Esc] Cancel "));
		return lines;
	}

	private getFooterText(): string {
		const bgLabel = this.runInBackground ? '[b]g:ON' : '[b]g';
		switch (this.mode) {
			case 'single':
				return ` [Enter] Run • [Esc] Cancel • e m t w s ${bgLabel} `;
			case 'parallel':
				return ` [Enter] Run • [Esc] Cancel • e m t s ${bgLabel} • ↑↓ Nav `;
			case 'chain':
				return ` [Enter] Run • [Esc] Cancel • e m t w r p s ${bgLabel} • ↑↓ Nav `;
		}
	}

	private appendNotice(lines: string[]): void {
		if (!this.noticeMessage) return;
		const color = this.noticeMessage.type === "error" ? "error" : "success";
		lines.push(this.row(` ${this.theme.fg(color, this.noticeMessage.text)}`));
	}

	private renderSingleMode(): string[] {
		const innerW = this.width - 2;
		const th = this.theme;
		const lines: string[] = [];

		const agentName = this.agentConfigs[0]?.name ?? "unknown";
		const maxHeaderLen = innerW - 4;
		const headerText = ` Agent: ${truncateToWidth(agentName, maxHeaderLen - 9)} `;
		lines.push(this.renderHeader(headerText));
		lines.push(this.row(""));

		const config = this.agentConfigs[0]!;
		const behavior = this.getEffectiveBehavior(0);

		const stepLabel = config.name;
		lines.push(this.row(` ${th.fg("accent", "▶ " + stepLabel)}`));

		const template = (this.templates[0] ?? "").split("\n")[0] ?? "";
		const taskLabel = th.fg("dim", "task: ");
		lines.push(this.row(`     ${taskLabel}${truncateToWidth(template, innerW - 12)}`));

		const effectiveModel = this.getEffectiveModel(0);
		const override = this.behaviorOverrides.get(0);
		const isOverridden = override?.model !== undefined;
		const modelValue = isOverridden
			? th.fg("warning", effectiveModel) + th.fg("dim", " ✎")
			: effectiveModel;
		const modelLabel = th.fg("dim", "model: ");
		lines.push(this.row(`     ${modelLabel}${truncateToWidth(modelValue, innerW - 13)}`));

		const writesValue = behavior.output === false
			? th.fg("dim", "(disabled)")
			: (behavior.output || th.fg("dim", "(none)"));
		const writesLabel = th.fg("dim", "writes: ");
		lines.push(this.row(`     ${writesLabel}${truncateToWidth(writesValue, innerW - 14)}`));

		const skillsValue = behavior.skills === false
			? th.fg("dim", "(disabled)")
			: (behavior.skills?.length ? behavior.skills.join(", ") : th.fg("dim", "(none)"));
		const skillsLabel = th.fg("dim", "skills: ");
		lines.push(this.row(`     ${skillsLabel}${truncateToWidth(skillsValue, innerW - 14)}`));

		lines.push(this.row(""));

		this.appendNotice(lines);
		lines.push(this.renderFooter(this.getFooterText()));

		return lines;
	}

	private renderParallelMode(): string[] {
		const innerW = this.width - 2;
		const th = this.theme;
		const lines: string[] = [];

		const headerText = ` Parallel Tasks (${this.agentConfigs.length}) `;
		lines.push(this.renderHeader(headerText));
		lines.push(this.row(""));

		for (let i = 0; i < this.agentConfigs.length; i++) {
			const config = this.agentConfigs[i]!;
			const isSelected = i === this.selectedStep;

			const color = isSelected ? "accent" : "dim";
			const prefix = isSelected ? "▶ " : "  ";
			const taskPrefix = `Task ${i + 1}: `;
			const maxNameLen = innerW - 4 - prefix.length - taskPrefix.length;
			const agentName = config.name.length > maxNameLen
				? config.name.slice(0, maxNameLen - 1) + "…"
				: config.name;
			const taskLabel = `${taskPrefix}${agentName}`;
			lines.push(this.row(` ${th.fg(color, prefix + taskLabel)}`));

			const template = (this.templates[i] ?? "").split("\n")[0] ?? "";
			const taskTextLabel = th.fg("dim", "task: ");
			lines.push(this.row(`     ${taskTextLabel}${truncateToWidth(template, innerW - 12)}`));

			const effectiveModel = this.getEffectiveModel(i);
			const override = this.behaviorOverrides.get(i);
			const isOverridden = override?.model !== undefined;
			const modelValue = isOverridden
				? th.fg("warning", effectiveModel) + th.fg("dim", " ✎")
				: effectiveModel;
			const modelLabel = th.fg("dim", "model: ");
			lines.push(this.row(`     ${modelLabel}${truncateToWidth(modelValue, innerW - 13)}`));

			const behavior = this.getEffectiveBehavior(i);
			const skillsValue = behavior.skills === false
				? th.fg("dim", "(disabled)")
				: (behavior.skills?.length ? behavior.skills.join(", ") : th.fg("dim", "(none)"));
			const skillsLabel = th.fg("dim", "skills: ");
			lines.push(this.row(`     ${skillsLabel}${truncateToWidth(skillsValue, innerW - 14)}`));

			lines.push(this.row(""));
		}

		this.appendNotice(lines);
		lines.push(this.renderFooter(this.getFooterText()));

		return lines;
	}

	private renderChainMode(): string[] {
		const innerW = this.width - 2;
		const th = this.theme;
		const lines: string[] = [];

		const chainLabel = this.agentConfigs.map((c) => c.name).join(" → ");
		const maxHeaderLen = innerW - 4;
		const headerText = ` Chain: ${truncateToWidth(chainLabel, maxHeaderLen - 9)} `;
		lines.push(this.renderHeader(headerText));

		lines.push(this.row(""));

		const taskPreview = truncateToWidth(this.originalTask, innerW - 16);
		lines.push(this.row(` Original Task: ${taskPreview}`));
		const chainDirPreview = truncateToWidth(this.chainDir ?? "", innerW - 12);
		lines.push(this.row(` Chain Dir: ${th.fg("dim", chainDirPreview)}`));

		const progressEnabled = this.agentConfigs.some((_, i) => this.getEffectiveBehavior(i).progress);
		const progressValue = progressEnabled ? th.fg("success", "enabled") : th.fg("dim", "disabled");
		lines.push(this.row(` Progress: ${progressValue} ${th.fg("dim", "(press [p] to toggle)")}`));
		lines.push(this.row(""));

		for (let i = 0; i < this.agentConfigs.length; i++) {
			const config = this.agentConfigs[i]!;
			const isSelected = i === this.selectedStep;
			const behavior = this.getEffectiveBehavior(i);

			const color = isSelected ? "accent" : "dim";
			const prefix = isSelected ? "▶ " : "  ";
			const stepPrefix = `Step ${i + 1}: `;
			const maxNameLen = innerW - 4 - prefix.length - stepPrefix.length;
			const agentName = config.name.length > maxNameLen
				? config.name.slice(0, maxNameLen - 1) + "…"
				: config.name;
			const stepLabel = `${stepPrefix}${agentName}`;
			lines.push(
				this.row(` ${th.fg(color, prefix + stepLabel)}`),
			);

			const template = (this.templates[i] ?? "").split("\n")[0] ?? "";
			const highlighted = template
				.replace(/\{task\}/g, th.fg("success", "{task}"))
				.replace(/\{previous\}/g, th.fg("warning", "{previous}"))
				.replace(/\{chain_dir\}/g, th.fg("accent", "{chain_dir}"));

			const templateLabel = th.fg("dim", "task: ");
			lines.push(this.row(`     ${templateLabel}${truncateToWidth(highlighted, innerW - 12)}`));

			const effectiveModel = this.getEffectiveModel(i);
			const override = this.behaviorOverrides.get(i);
			const isOverridden = override?.model !== undefined;
			const modelValue = isOverridden
				? th.fg("warning", effectiveModel) + th.fg("dim", " ✎")
				: effectiveModel;
			const modelLabel = th.fg("dim", "model: ");
			lines.push(this.row(`     ${modelLabel}${truncateToWidth(modelValue, innerW - 13)}`));

			const writesValue = behavior.output === false
				? th.fg("dim", "(disabled)")
				: (behavior.output || th.fg("dim", "(none)"));
			const writesLabel = th.fg("dim", "writes: ");
			lines.push(this.row(`     ${writesLabel}${truncateToWidth(writesValue, innerW - 14)}`));

			const readsValue = behavior.reads === false
				? th.fg("dim", "(disabled)")
				: (behavior.reads && behavior.reads.length > 0
					? behavior.reads.join(", ")
					: th.fg("dim", "(none)"));
			const readsLabel = th.fg("dim", "reads: ");
			lines.push(this.row(`     ${readsLabel}${truncateToWidth(readsValue, innerW - 13)}`));

			const skillsValue = behavior.skills === false
				? th.fg("dim", "(disabled)")
				: (behavior.skills?.length ? behavior.skills.join(", ") : th.fg("dim", "(none)"));
			const skillsLabel = th.fg("dim", "skills: ");
			lines.push(this.row(`     ${skillsLabel}${truncateToWidth(skillsValue, innerW - 14)}`));

			if (progressEnabled) {
				const isFirstStep = i === 0;
				const progressAction = isFirstStep 
					? th.fg("success", "writes progress.md")
					: th.fg("accent", "reads progress.md");
				const progressLabel = th.fg("dim", "progress: ");
				lines.push(this.row(`     ${progressLabel}${progressAction}`));
			}

			if (i < this.agentConfigs.length - 1) {
				const nextStepUsePrevious = (this.templates[i + 1] ?? "").includes("{previous}");
				if (nextStepUsePrevious) {
					const indicator = th.fg("dim", "     ↳ response → ") + th.fg("warning", "{previous}");
					lines.push(this.row(indicator));
				}
			}

			lines.push(this.row(""));
		}

		this.appendNotice(lines);
		lines.push(this.renderFooter(this.getFooterText()));

		return lines;
	}

	// TUI Component lifecycle method invoked through the Component interface.
	readonly invalidate = (): void => {};
	// TUI Component lifecycle method invoked through the Component interface.
	readonly dispose = (): void => {
		if (this.noticeMessageTimer) clearTimeout(this.noticeMessageTimer);
		this.noticeMessageTimer = null;
	};
}

export function bindChainClarifyComponent(component: ChainClarifyComponent): Component & { dispose(): void } {
	return {
		render: (width: number) => component.render(width),
		handleInput: (data: string) => component.handleInput(data),
		invalidate: () => component.invalidate(),
		dispose: () => component.dispose(),
	};
}
