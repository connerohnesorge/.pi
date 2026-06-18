import type { AgentConfig } from "../../agents/agents.ts";
import { findModelInfo, getSupportedThinkingLevels, type ModelInfo, type ThinkingLevel } from "../../shared/model-info.ts";
import type { ResolvedStepBehavior } from "../../shared/settings.ts";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { resolveModelCandidate, splitThinkingSuffix } from "../shared/model-fallback.ts";

export type ClarifyMode = "single" | "parallel" | "chain";

export interface BehaviorOverride {
	output?: string | false;
	reads?: string[] | false;
	progress?: boolean;
	model?: string;
	skills?: string[] | false;
}

export interface ChainClarifyResult {
	confirmed: boolean;
	templates: string[];
	behaviorOverrides: (BehaviorOverride | undefined)[];
	runInBackground?: boolean;
}

export type EditMode = "template" | "output" | "reads" | "model" | "thinking" | "skills";

export interface TextEditorState {
	buffer: string;
	cursor: number;
	viewportOffset: number;
}

export interface SkillInfo {
	name: string;
	source: string;
	description?: string;
}

export type ChainClarifyInputAction =
	| { kind: "none" }
	| { kind: "render" }
	| { kind: "confirm"; result: ChainClarifyResult }
	| { kind: "cancel"; result: ChainClarifyResult }
	| { kind: "notice"; text: string; noticeType: "info" | "error" };

export interface ChainClarifyModelOptions {
	agentConfigs: AgentConfig[];
	templates: string[];
	originalTask: string;
	chainDir: string | undefined;
	resolvedBehaviors: ResolvedStepBehavior[];
	availableModels: ModelInfo[];
	preferredProvider: string | undefined;
	availableSkills: SkillInfo[];
	mode?: ClarifyMode;
}

export function createEditorState(initial = ""): TextEditorState {
	return { buffer: initial, cursor: 0, viewportOffset: 0 };
}

export function wrapText(text: string, width: number): { lines: string[]; starts: number[] } {
	if (width <= 0) return { lines: [text], starts: [0] };
	if (text.length === 0) return { lines: [""], starts: [0] };

	const lines: string[] = [];
	const starts: number[] = [];
	let offset = 0;
	const segments = text.split("\n");
	for (const [index, segment] of segments.entries()) {
		if (segment.length === 0) {
			starts.push(offset);
			lines.push("");
		} else {
			let lineStart = 0;
			let pos = 0;
			let lineWidth = 0;
			while (pos < segment.length) {
				const char = String.fromCodePoint(segment.codePointAt(pos)!);
				const charWidth = visibleWidth(char);
				if (lineWidth > 0 && lineWidth + charWidth > width) {
					starts.push(offset + lineStart);
					lines.push(segment.slice(lineStart, pos));
					lineStart = pos;
					lineWidth = 0;
					continue;
				}
				pos += char.length;
				lineWidth += charWidth;
			}
			starts.push(offset + lineStart);
			lines.push(segment.slice(lineStart));
		}
		offset += segment.length + (index < segments.length - 1 ? 1 : 0);
	}
	if (!text.endsWith("\n") && text.length > 0 && visibleWidth(lines[lines.length - 1] ?? "") === width) {
		starts.push(text.length);
		lines.push("");
	}
	return { lines, starts };
}

export function getCursorDisplayPos(cursor: number, starts: number[]): { line: number; col: number } {
	for (let i = starts.length - 1; i >= 0; i--) {
		if (cursor >= starts[i]!) return { line: i, col: cursor - starts[i]! };
	}
	return { line: 0, col: 0 };
}

export function ensureCursorVisible(cursorLine: number, viewportHeight: number, currentOffset: number): number {
	if (cursorLine < currentOffset) return Math.max(0, cursorLine);
	if (cursorLine >= currentOffset + viewportHeight) return Math.max(0, cursorLine - viewportHeight + 1);
	return Math.max(0, currentOffset);
}

function isWordChar(ch: string): boolean {
	const code = ch.charCodeAt(0);
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function wordBackward(buffer: string, cursor: number): number {
	let pos = cursor;
	while (pos > 0 && !isWordChar(buffer[pos - 1]!)) pos--;
	while (pos > 0 && isWordChar(buffer[pos - 1]!)) pos--;
	return pos;
}

function wordForward(buffer: string, cursor: number): number {
	let pos = cursor;
	while (pos < buffer.length && isWordChar(buffer[pos]!)) pos++;
	while (pos < buffer.length && !isWordChar(buffer[pos]!)) pos++;
	return pos;
}

function normalizeInsertText(data: string): string | null {
	let text = data.split("\x1b[200~").join("").split("\x1b[201~").join("");
	text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const newline = text.indexOf("\n");
	if (newline !== -1) text = text.slice(0, newline);
	text = text.replace(/\t/g, "    ");
	if (text.length === 0) return null;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) < 32) return null;
	}
	return text;
}

export function handleEditorInput(state: TextEditorState, data: string, textWidth: number): TextEditorState | null {
	if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "return")) return null;

	const { lines: wrapped, starts } = wrapText(state.buffer, textWidth);
	const cursorPos = getCursorDisplayPos(state.cursor, starts);

	if (matchesKey(data, "alt+left") || matchesKey(data, "ctrl+left")) return { ...state, cursor: wordBackward(state.buffer, state.cursor) };
	if (matchesKey(data, "alt+right") || matchesKey(data, "ctrl+right")) return { ...state, cursor: wordForward(state.buffer, state.cursor) };
	if (matchesKey(data, "left")) return state.cursor > 0 ? { ...state, cursor: state.cursor - 1 } : state;
	if (matchesKey(data, "right")) return state.cursor < state.buffer.length ? { ...state, cursor: state.cursor + 1 } : state;
	if (matchesKey(data, "up") && cursorPos.line > 0) {
		const targetLine = cursorPos.line - 1;
		return { ...state, cursor: starts[targetLine]! + Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0) };
	}
	if (matchesKey(data, "down") && cursorPos.line < wrapped.length - 1) {
		const targetLine = cursorPos.line + 1;
		return { ...state, cursor: starts[targetLine]! + Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0) };
	}
	if (matchesKey(data, "home")) return { ...state, cursor: starts[cursorPos.line]! };
	if (matchesKey(data, "end")) return { ...state, cursor: starts[cursorPos.line]! + (wrapped[cursorPos.line]?.length ?? 0) };
	if (matchesKey(data, "ctrl+home")) return { ...state, cursor: 0 };
	if (matchesKey(data, "ctrl+end")) return { ...state, cursor: state.buffer.length };
	if (matchesKey(data, "alt+backspace")) {
		const target = wordBackward(state.buffer, state.cursor);
		return target === state.cursor ? state : { ...state, buffer: state.buffer.slice(0, target) + state.buffer.slice(state.cursor), cursor: target };
	}
	if (matchesKey(data, "backspace")) {
		return state.cursor > 0
			? { ...state, buffer: state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor), cursor: state.cursor - 1 }
			: state;
	}
	if (matchesKey(data, "delete")) {
		return state.cursor < state.buffer.length
			? { ...state, buffer: state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1) }
			: state;
	}

	const insert = normalizeInsertText(data);
	return insert
		? { ...state, buffer: state.buffer.slice(0, state.cursor) + insert + state.buffer.slice(state.cursor), cursor: state.cursor + insert.length }
		: null;
}

const noAction: ChainClarifyInputAction = { kind: "none" };
const renderAction: ChainClarifyInputAction = { kind: "render" };

export class ChainClarifyModel {
	selectedStep = 0;
	editingStep: number | null = null;
	editMode: EditMode = "template";
	editState: TextEditorState = createEditorState();
	readonly behaviorOverrides: Map<number, BehaviorOverride> = new Map();
	modelSearchQuery = "";
	modelSelectedIndex = 0;
	filteredModels: ModelInfo[];
	thinkingSelectedIndex = 0;
	skillSearchQuery = "";
	readonly skillSelectedNames: Set<string> = new Set();
	skillCursorIndex = 0;
	filteredSkills: SkillInfo[];
	runInBackground = false;
	readonly agentConfigs: AgentConfig[];
	readonly templates: string[];
	readonly originalTask: string;
	readonly chainDir: string | undefined;
	readonly resolvedBehaviors: ResolvedStepBehavior[];
	readonly availableModels: ModelInfo[];
	readonly preferredProvider: string | undefined;
	readonly availableSkills: SkillInfo[];
	readonly mode: ClarifyMode;

	constructor(options: ChainClarifyModelOptions) {
		this.agentConfigs = options.agentConfigs;
		this.templates = options.templates;
		this.originalTask = options.originalTask;
		this.chainDir = options.chainDir;
		this.resolvedBehaviors = options.resolvedBehaviors;
		this.availableModels = options.availableModels;
		this.preferredProvider = options.preferredProvider;
		this.availableSkills = options.availableSkills;
		this.mode = options.mode ?? "chain";
		this.filteredModels = [...options.availableModels];
		this.filteredSkills = [...options.availableSkills];
	}

	getEffectiveBehavior(stepIndex: number): ResolvedStepBehavior {
		const base = this.resolvedBehaviors[stepIndex]!;
		const override = this.behaviorOverrides.get(stepIndex);
		if (!override) return base;

		return {
			output: override.output !== undefined ? override.output : base.output,
			outputMode: base.outputMode,
			reads: override.reads !== undefined ? override.reads : base.reads,
			progress: override.progress !== undefined ? override.progress : base.progress,
			skills: override.skills !== undefined ? override.skills : base.skills,
			model: override.model !== undefined ? override.model : base.model,
		};
	}

	getEffectiveModel(stepIndex: number): string {
		const override = this.behaviorOverrides.get(stepIndex);
		if (override?.model) return this.resolveModelFullId(override.model);

		const baseModel = this.resolvedBehaviors[stepIndex]?.model;
		if (baseModel) return this.resolveModelFullId(baseModel);
		return "default";
	}

	resolveModelFullId(modelName: string): string {
		return resolveModelCandidate(modelName, this.availableModels, this.preferredProvider) ?? modelName;
	}

	updateBehavior(stepIndex: number, field: keyof BehaviorOverride, value: string | boolean | string[] | false): void {
		const existing = this.behaviorOverrides.get(stepIndex) ?? {};
		this.behaviorOverrides.set(stepIndex, { ...existing, [field]: value });
	}

	cancelResult(): ChainClarifyResult {
		return { confirmed: false, templates: [], behaviorOverrides: [] };
	}

	confirmResult(): ChainClarifyResult {
		const overrides: (BehaviorOverride | undefined)[] = [];
		for (let i = 0; i < this.agentConfigs.length; i++) {
			overrides.push(this.behaviorOverrides.get(i));
		}
		return { confirmed: true, templates: this.templates, behaviorOverrides: overrides, runInBackground: this.runInBackground };
	}

	exitEditMode(): void {
		this.editingStep = null;
		this.editState = createEditorState();
	}

	enterEditMode(mode: EditMode): void {
		this.editingStep = this.selectedStep;
		this.editMode = mode;
		let buffer = "";

		if (mode === "template") {
			const template = this.templates[this.selectedStep] ?? "";
			buffer = template.split("\n")[0] ?? "";
		} else if (mode === "output") {
			const behavior = this.getEffectiveBehavior(this.selectedStep);
			buffer = behavior.output === false ? "" : (behavior.output || "");
		} else if (mode === "reads") {
			const behavior = this.getEffectiveBehavior(this.selectedStep);
			buffer = behavior.reads === false ? "" : (behavior.reads?.join(", ") || "");
		}

		this.editState = createEditorState(buffer);
	}

	enterModelSelector(): void {
		this.editingStep = this.selectedStep;
		this.editMode = "model";
		this.modelSearchQuery = "";
		this.modelSelectedIndex = 0;
		this.filteredModels = [...this.availableModels];
		const currentModel = splitThinkingSuffix(this.getEffectiveModel(this.selectedStep)).baseModel;
		const currentIndex = this.filteredModels.findIndex((m) => m.fullId === currentModel || m.id === currentModel);
		if (currentIndex >= 0) {
			this.modelSelectedIndex = currentIndex;
		}
	}

	filterModels(): void {
		const query = this.modelSearchQuery.toLowerCase();
		if (!query) {
			this.filteredModels = [...this.availableModels];
		} else {
			this.filteredModels = this.availableModels.filter((m) =>
				m.fullId.toLowerCase().includes(query) ||
				m.id.toLowerCase().includes(query) ||
				m.provider.toLowerCase().includes(query)
			);
		}
		this.modelSelectedIndex = Math.min(this.modelSelectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	handleModelSelectorInput(data: string): ChainClarifyInputAction {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.exitEditMode();
			return renderAction;
		}

		if (matchesKey(data, "return")) {
			const selected = this.filteredModels[this.modelSelectedIndex];
			if (selected) {
				const { thinkingSuffix } = splitThinkingSuffix(this.getEffectiveModel(this.editingStep!));
				const requestedLevel = thinkingSuffix.slice(1);
				const selectedModel = findModelInfo(selected.fullId, this.availableModels, this.preferredProvider);
				const suffix = getSupportedThinkingLevels(selectedModel).some((level) => level === requestedLevel) ? thinkingSuffix : "";
				this.updateBehavior(this.editingStep!, "model", `${selected.fullId}${suffix}`);
			}
			this.exitEditMode();
			return renderAction;
		}

		if (matchesKey(data, "up")) {
			if (this.filteredModels.length > 0) {
				this.modelSelectedIndex = this.modelSelectedIndex === 0
					? this.filteredModels.length - 1
					: this.modelSelectedIndex - 1;
			}
			return renderAction;
		}

		if (matchesKey(data, "down")) {
			if (this.filteredModels.length > 0) {
				this.modelSelectedIndex = this.modelSelectedIndex === this.filteredModels.length - 1
					? 0
					: this.modelSelectedIndex + 1;
			}
			return renderAction;
		}

		if (matchesKey(data, "backspace")) {
			if (this.modelSearchQuery.length > 0) {
				this.modelSearchQuery = this.modelSearchQuery.slice(0, -1);
				this.filterModels();
			}
			return renderAction;
		}

		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.modelSearchQuery += data;
			this.filterModels();
			return renderAction;
		}
		return noAction;
	}

	getAvailableThinkingLevels(stepIndex: number): ThinkingLevel[] {
		return getSupportedThinkingLevels(findModelInfo(this.getEffectiveModel(stepIndex), this.availableModels, this.preferredProvider));
	}

	enterThinkingSelector(): ChainClarifyInputAction {
		if (!this.getEffectiveBehavior(this.selectedStep).model) {
			return { kind: "notice", text: "Select a model first", noticeType: "error" };
		}
		this.editingStep = this.selectedStep;
		this.editMode = "thinking";

		const levels = this.getAvailableThinkingLevels(this.selectedStep);
		const { thinkingSuffix } = splitThinkingSuffix(this.getEffectiveModel(this.selectedStep));
		const suffix = thinkingSuffix.slice(1);
		const levelIdx = levels.findIndex((level) => level === suffix);
		this.thinkingSelectedIndex = levelIdx >= 0 ? levelIdx : Math.max(0, levels.indexOf("off"));
		return renderAction;
	}

	handleThinkingSelectorInput(data: string): ChainClarifyInputAction {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.exitEditMode();
			return renderAction;
		}

		const levels = this.getAvailableThinkingLevels(this.editingStep!);
		if (levels.length === 0) return noAction;

		if (matchesKey(data, "return")) {
			const selectedLevel = levels[this.thinkingSelectedIndex] ?? "off";
			this.applyThinkingLevel(selectedLevel);
			this.exitEditMode();
			return renderAction;
		}

		if (matchesKey(data, "up")) {
			this.thinkingSelectedIndex = this.thinkingSelectedIndex === 0
				? levels.length - 1
				: this.thinkingSelectedIndex - 1;
			return renderAction;
		}

		if (matchesKey(data, "down")) {
			this.thinkingSelectedIndex = this.thinkingSelectedIndex === levels.length - 1
				? 0
				: this.thinkingSelectedIndex + 1;
			return renderAction;
		}
		return noAction;
	}

	applyThinkingLevel(level: ThinkingLevel): void {
		const stepIndex = this.editingStep!;
		const currentModel = this.getEffectiveBehavior(stepIndex).model;
		if (!currentModel) return;

		const { baseModel } = splitThinkingSuffix(currentModel);
		const newModel = level === "off" ? baseModel : `${baseModel}:${level}`;
		this.updateBehavior(stepIndex, "model", newModel);
	}

	enterSkillSelector(): void {
		this.editingStep = this.selectedStep;
		this.editMode = "skills";
		this.skillSearchQuery = "";
		this.skillCursorIndex = 0;
		this.filteredSkills = [...this.availableSkills];
		const current = this.getEffectiveBehavior(this.selectedStep).skills;
		this.skillSelectedNames.clear();
		if (current !== false && current.length > 0) {
			current.forEach((skillName) => this.skillSelectedNames.add(skillName));
		}
	}

	filterSkills(): void {
		const query = this.skillSearchQuery.toLowerCase();
		if (!query) {
			this.filteredSkills = [...this.availableSkills];
		} else {
			this.filteredSkills = this.availableSkills.filter((s) =>
				s.name.toLowerCase().includes(query) ||
				(s.description?.toLowerCase().includes(query) ?? false),
			);
		}
		this.skillCursorIndex = Math.min(this.skillCursorIndex, Math.max(0, this.filteredSkills.length - 1));
	}

	handleSkillSelectorInput(data: string): ChainClarifyInputAction {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.exitEditMode();
			return renderAction;
		}

		if (matchesKey(data, "return")) {
			const selected = [...this.skillSelectedNames];
			this.updateBehavior(this.editingStep!, "skills", selected);
			this.exitEditMode();
			return renderAction;
		}

		if (data === " ") {
			if (this.filteredSkills.length > 0) {
				const skill = this.filteredSkills[this.skillCursorIndex];
				if (skill) {
					if (this.skillSelectedNames.has(skill.name)) {
						this.skillSelectedNames.delete(skill.name);
					} else {
						this.skillSelectedNames.add(skill.name);
					}
				}
			}
			return renderAction;
		}

		if (matchesKey(data, "up")) {
			if (this.filteredSkills.length > 0) {
				this.skillCursorIndex = this.skillCursorIndex === 0
					? this.filteredSkills.length - 1
					: this.skillCursorIndex - 1;
			}
			return renderAction;
		}

		if (matchesKey(data, "down")) {
			if (this.filteredSkills.length > 0) {
				this.skillCursorIndex = this.skillCursorIndex === this.filteredSkills.length - 1
					? 0
					: this.skillCursorIndex + 1;
			}
			return renderAction;
		}

		if (matchesKey(data, "backspace")) {
			if (this.skillSearchQuery.length > 0) {
				this.skillSearchQuery = this.skillSearchQuery.slice(0, -1);
				this.filterSkills();
			}
			return renderAction;
		}

		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.skillSearchQuery += data;
			this.filterSkills();
			return renderAction;
		}
		return noAction;
	}

	handleEditInput(data: string, textWidth: number, viewportHeight: number): ChainClarifyInputAction {
		if (matchesKey(data, "shift+up") || matchesKey(data, "pageup")) {
			const { lines: wrapped, starts } = wrapText(this.editState.buffer, textWidth);
			const cursorPos = getCursorDisplayPos(this.editState.cursor, starts);
			const targetLine = Math.max(0, cursorPos.line - viewportHeight);
			const targetCol = Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0);
			this.editState = { ...this.editState, cursor: starts[targetLine] + targetCol };
			return renderAction;
		}

		if (matchesKey(data, "shift+down") || matchesKey(data, "pagedown")) {
			const { lines: wrapped, starts } = wrapText(this.editState.buffer, textWidth);
			const cursorPos = getCursorDisplayPos(this.editState.cursor, starts);
			const targetLine = Math.min(wrapped.length - 1, cursorPos.line + viewportHeight);
			const targetCol = Math.min(cursorPos.col, wrapped[targetLine]?.length ?? 0);
			this.editState = { ...this.editState, cursor: starts[targetLine] + targetCol };
			return renderAction;
		}

		if (matchesKey(data, "tab")) return noAction;

		const nextState = handleEditorInput(this.editState, data, textWidth);
		if (nextState) {
			this.editState = nextState;
			return renderAction;
		}

		if (matchesKey(data, "escape")) {
			this.saveEdit();
			this.exitEditMode();
			return renderAction;
		}

		if (matchesKey(data, "ctrl+c")) {
			this.exitEditMode();
			return renderAction;
		}
		return noAction;
	}

	saveEdit(): void {
		const stepIndex = this.editingStep!;

		if (this.editMode === "template") {
			const original = this.templates[stepIndex] ?? "";
			const originalLines = original.split("\n");
			originalLines[0] = this.editState.buffer;
			this.templates[stepIndex] = originalLines.join("\n");
		} else if (this.editMode === "output") {
			const oldBehavior = this.getEffectiveBehavior(stepIndex);
			const oldOutput = typeof oldBehavior.output === "string" ? oldBehavior.output : null;

			const trimmed = this.editState.buffer.trim();
			const newOutput = trimmed === "" ? false : trimmed;
			this.updateBehavior(stepIndex, "output", newOutput);

			if (oldOutput && typeof newOutput === "string" && oldOutput !== newOutput) {
				this.propagateOutputChange(stepIndex, oldOutput, newOutput);
			}
		} else if (this.editMode === "reads") {
			const trimmed = this.editState.buffer.trim();
			if (trimmed === "") {
				this.updateBehavior(stepIndex, "reads", false);
			} else {
				const files = trimmed.split(",").map(f => f.trim()).filter(f => f !== "");
				this.updateBehavior(stepIndex, "reads", files.length > 0 ? files : false);
			}
		}
	}

	propagateOutputChange(changedStepIndex: number, oldOutput: string, newOutput: string): void {
		for (let i = changedStepIndex + 1; i < this.agentConfigs.length; i++) {
			const behavior = this.getEffectiveBehavior(i);
			if (behavior.reads === false || !behavior.reads || behavior.reads.length === 0) {
				continue;
			}

			const readsArray = behavior.reads;
			const oldIndex = readsArray.indexOf(oldOutput);
			if (oldIndex !== -1) {
				const newReads = [...readsArray];
				newReads[oldIndex] = newOutput;
				this.updateBehavior(i, "reads", newReads);
			}
		}
	}

	handleInput(data: string, textWidth: number, editViewportHeight: number): ChainClarifyInputAction {
		if (this.editingStep !== null) {
			if (this.editMode === "model") return this.handleModelSelectorInput(data);
			if (this.editMode === "thinking") return this.handleThinkingSelectorInput(data);
			if (this.editMode === "skills") return this.handleSkillSelectorInput(data);
			return this.handleEditInput(data, textWidth, editViewportHeight);
		}

		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			return { kind: "cancel", result: this.cancelResult() };
		}

		if (matchesKey(data, "return")) {
			return { kind: "confirm", result: this.confirmResult() };
		}

		if (matchesKey(data, "up")) {
			this.selectedStep = Math.max(0, this.selectedStep - 1);
			return renderAction;
		}

		if (matchesKey(data, "down")) {
			const maxStep = Math.max(0, this.agentConfigs.length - 1);
			this.selectedStep = Math.min(maxStep, this.selectedStep + 1);
			return renderAction;
		}

		if (data === "e") {
			this.enterEditMode("template");
			return renderAction;
		}

		if (data === "m") {
			this.enterModelSelector();
			return renderAction;
		}

		if (data === "t") {
			return this.enterThinkingSelector();
		}

		if (data === "s") {
			this.enterSkillSelector();
			return renderAction;
		}

		if (data === "w" && this.mode !== "parallel") {
			this.enterEditMode("output");
			return renderAction;
		}

		if (data === "r" && this.mode === "chain") {
			this.enterEditMode("reads");
			return renderAction;
		}

		if (data === "p" && this.mode === "chain") {
			const anyEnabled = this.agentConfigs.some((_, i) => this.getEffectiveBehavior(i).progress);
			const newState = !anyEnabled;
			for (let i = 0; i < this.agentConfigs.length; i++) {
				this.updateBehavior(i, "progress", newState);
			}
			return renderAction;
		}

		if (data === "b") {
			this.runInBackground = !this.runInBackground;
			return renderAction;
		}

		return noAction;
	}
}
