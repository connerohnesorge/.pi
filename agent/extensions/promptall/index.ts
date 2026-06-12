import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext, KeybindingsManager, SessionInfo } from "@earendil-works/pi-coding-agent";
import { CustomEditor, SessionManager } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { decodeKittyPrintable, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	DEFAULT_HISTORY_LIMIT,
	buildPromptHistory,
	extractPromptsFromEntries,
	extractPromptsFromSessionJsonl,
	filterPromptHistory,
	type PromptHistoryItem,
} from "./prompt-history.ts";

export interface PromptallHistoryDeps {
	listSessions?: () => Promise<SessionInfo[]>;
	readSessionFile?: (path: string) => Promise<string>;
	limit?: number;
}

export interface PromptallExtensionDeps extends PromptallHistoryDeps {
	loadHistory?: (ctx: ExtensionContext) => Promise<PromptHistoryItem[]>;
	selectPrompt?: (ctx: ExtensionContext, prompts: PromptHistoryItem[]) => Promise<PromptHistoryItem | null>;
}

async function readUtf8(path: string): Promise<string> {
	return readFile(path, "utf8");
}

function modifiedMs(session: SessionInfo): number | undefined {
	return session.modified instanceof Date ? session.modified.getTime() : undefined;
}

function displayPath(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const base = basename(path);
	if (base) return base;
	return path;
}

function formatWhen(timestampMs: number): string | undefined {
	if (!Number.isFinite(timestampMs) || timestampMs <= 0) return undefined;
	return new Date(timestampMs).toLocaleString();
}

function formatPromptDescription(prompt: PromptHistoryItem): string {
	const sessionDir = prompt.sessionPath ? displayPath(dirname(prompt.sessionPath)) : undefined;
	const where = prompt.sessionName ?? displayPath(prompt.cwd) ?? sessionDir;
	const parts = [formatWhen(prompt.timestampMs), where, prompt.source === "current" ? "current" : undefined].filter(
		(part): part is string => Boolean(part),
	);
	return parts.join(" • ");
}

export async function loadPromptHistory(
	ctx: ExtensionContext,
	deps: PromptallHistoryDeps = {},
): Promise<PromptHistoryItem[]> {
	const listSessions = deps.listSessions ?? (() => SessionManager.listAll());
	const readSessionFile = deps.readSessionFile ?? readUtf8;
	const limit = deps.limit ?? DEFAULT_HISTORY_LIMIT;
	const savedPrompts: PromptHistoryItem[] = [];

	const sessions = await listSessions();
	const loaded = await Promise.allSettled(
		sessions.map(async (session) => {
			const content = await readSessionFile(session.path);
			return extractPromptsFromSessionJsonl(content, {
				source: "saved",
				sessionPath: session.path,
				cwd: session.cwd,
				sessionName: session.name,
				modifiedMs: modifiedMs(session),
			});
		}),
	);

	for (const result of loaded) {
		if (result.status === "fulfilled") savedPrompts.push(...result.value);
	}

	const currentPrompts = extractPromptsFromEntries(ctx.sessionManager.getBranch(), {
		source: "current",
		sessionPath: ctx.sessionManager.getSessionFile(),
		cwd: ctx.cwd,
		sessionName: ctx.sessionManager.getSessionName(),
	});

	return buildPromptHistory([...savedPrompts, ...currentPrompts], limit);
}

type PickerKeybindings = {
	matches(data: string, keybinding: string): boolean;
};

function decodePrintableInput(data: string): string | undefined {
	const kittyPrintable = decodeKittyPrintable(data);
	if (kittyPrintable) return kittyPrintable;
	if (data.length === 0 || data.includes("\x1b")) return undefined;
	return [...data].every((char) => char >= " " && char !== "\x7f") ? data : undefined;
}

function clampSelectedIndex(index: number, filteredLength: number): number {
	if (filteredLength <= 0) return 0;
	return Math.max(0, Math.min(index, filteredLength - 1));
}

export async function selectPromptWithTui(
	ctx: ExtensionContext,
	prompts: PromptHistoryItem[],
): Promise<PromptHistoryItem | null> {
	return ctx.ui.custom<PromptHistoryItem | null>((tui, theme, keybindings: PickerKeybindings, done) => {
		let query = "";
		let filtered = prompts;
		let selectedIndex = 0;
		const maxVisible = Math.min(prompts.length, 12);

		function refilter(): void {
			filtered = filterPromptHistory(prompts, query);
			selectedIndex = clampSelectedIndex(selectedIndex, filtered.length);
		}

		function move(delta: number): void {
			if (filtered.length === 0) return;
			selectedIndex = (selectedIndex + delta + filtered.length) % filtered.length;
		}

		function visiblePrompts(): PromptHistoryItem[] {
			if (filtered.length <= maxVisible) return filtered;
			const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), filtered.length - maxVisible));
			return filtered.slice(start, start + maxVisible);
		}

		function renderPromptLine(prompt: PromptHistoryItem, width: number): string {
			const isSelected = filtered[selectedIndex] === prompt;
			const prefix = isSelected ? "→ " : "  ";
			const description = formatPromptDescription(prompt);
			const rawLine = description ? `${prefix}${prompt.preview}  ${description}` : `${prefix}${prompt.preview}`;
			const line = truncateToWidth(rawLine, width, "");
			return isSelected ? theme.fg("accent", line) : line;
		}

		return {
			render(width: number) {
				const safeWidth = Math.max(1, width);
				const border = theme.fg("accent", "─".repeat(safeWidth));
				const queryDisplay = query ? query : theme.fg("dim", "type to filter");
				const lines = [
					border,
					truncateToWidth(theme.fg("accent", theme.bold("Prompt History")), safeWidth, ""),
					truncateToWidth(`Search: ${queryDisplay}`, safeWidth, ""),
					truncateToWidth(theme.fg("dim", "All saved sessions • enter insert • esc cancel"), safeWidth, ""),
				];

				if (filtered.length === 0) {
					lines.push(truncateToWidth(theme.fg("warning", "  No matching prompts"), safeWidth, ""));
				} else {
					for (const prompt of visiblePrompts()) {
						lines.push(renderPromptLine(prompt, safeWidth));
					}
					if (filtered.length > maxVisible) {
						lines.push(
							truncateToWidth(theme.fg("dim", `  (${selectedIndex + 1}/${filtered.length})`), safeWidth, ""),
						);
					}
				}

				const indexed = `${prompts.length} prompt${prompts.length === 1 ? "" : "s"} indexed`;
				const matched = query ? ` • ${filtered.length} match${filtered.length === 1 ? "" : "es"}` : "";
				lines.push(truncateToWidth(theme.fg("dim", indexed + matched), safeWidth, ""));
				lines.push(border);
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (keybindings.matches(data, "tui.select.up")) {
					move(-1);
				} else if (keybindings.matches(data, "tui.select.down")) {
					move(1);
				} else if (keybindings.matches(data, "tui.select.pageUp")) {
					move(-maxVisible);
				} else if (keybindings.matches(data, "tui.select.pageDown")) {
					move(maxVisible);
				} else if (keybindings.matches(data, "tui.select.confirm")) {
					done(filtered[selectedIndex] ?? null);
					return;
				} else if (keybindings.matches(data, "tui.select.cancel")) {
					done(null);
					return;
				} else if (keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, Key.backspace)) {
					query = query.slice(0, -1);
					refilter();
				} else if (keybindings.matches(data, "tui.editor.deleteToLineStart")) {
					query = "";
					refilter();
				} else {
					const printable = decodePrintableInput(data);
					if (printable) {
						query += printable;
						refilter();
					}
				}
				tui.requestRender();
			},
		};
	});
}

type PromptallEditorBase = EditorComponent & {
	focused?: boolean;
	actionHandlers?: Map<string, () => void>;
	onEscape?: () => void;
	onCtrlD?: () => void;
	onPasteImage?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
	dispose?: () => void;
};

class ForwardingActionMap extends Map<string, () => void> {
	private readonly base: PromptallEditorBase;

	constructor(base: PromptallEditorBase) {
		super();
		this.base = base;
	}

	override set(key: string, value: () => void): this {
		super.set(key, value);
		if (this.base.actionHandlers instanceof Map) {
			this.base.actionHandlers.set(key, value);
		}
		return this;
	}
}

class PromptallEditorWrapper implements EditorComponent {
	readonly actionHandlers: Map<string, () => void>;
	private opening = false;
	private _onEscape?: () => void;
	private _onCtrlD?: () => void;
	private _onPasteImage?: () => void;
	private _onExtensionShortcut?: (data: string) => boolean;
	private readonly base: PromptallEditorBase;
	private readonly ctx: ExtensionContext;
	private readonly deps: PromptallExtensionDeps;

	constructor(base: PromptallEditorBase, ctx: ExtensionContext, deps: PromptallExtensionDeps) {
		this.base = base;
		this.ctx = ctx;
		this.deps = deps;
		this.actionHandlers = new ForwardingActionMap(base);
	}

	get focused(): boolean {
		return Boolean(this.base.focused);
	}

	set focused(value: boolean) {
		this.base.focused = value;
	}

	get borderColor(): ((str: string) => string) | undefined {
		return this.base.borderColor;
	}

	set borderColor(value: ((str: string) => string) | undefined) {
		this.base.borderColor = value;
	}

	get onSubmit(): ((text: string) => void) | undefined {
		return this.base.onSubmit;
	}

	set onSubmit(value: ((text: string) => void) | undefined) {
		this.base.onSubmit = value;
	}

	get onChange(): ((text: string) => void) | undefined {
		return this.base.onChange;
	}

	set onChange(value: ((text: string) => void) | undefined) {
		this.base.onChange = value;
	}

	get onEscape(): (() => void) | undefined {
		return this._onEscape;
	}

	set onEscape(value: (() => void) | undefined) {
		this._onEscape = value;
		this.base.onEscape = value;
	}

	get onCtrlD(): (() => void) | undefined {
		return this._onCtrlD;
	}

	set onCtrlD(value: (() => void) | undefined) {
		this._onCtrlD = value;
		this.base.onCtrlD = value;
	}

	get onPasteImage(): (() => void) | undefined {
		return this._onPasteImage;
	}

	set onPasteImage(value: (() => void) | undefined) {
		this._onPasteImage = value;
		this.base.onPasteImage = value;
	}

	get onExtensionShortcut(): ((data: string) => boolean) | undefined {
		return this._onExtensionShortcut;
	}

	set onExtensionShortcut(value: ((data: string) => boolean) | undefined) {
		this._onExtensionShortcut = value;
		this.base.onExtensionShortcut = value;
	}

	render(width: number): string[] {
		return this.base.render(width);
	}

	invalidate(): void {
		this.base.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("r"))) {
			if (!this.opening) {
				this.opening = true;
				void openPromptallHistory(this.ctx, this.deps).finally(() => {
					this.opening = false;
				});
			}
			return;
		}

		this.base.handleInput(data);
	}

	getText(): string {
		return this.base.getText();
	}

	setText(text: string): void {
		this.base.setText(text);
	}

	addToHistory(text: string): void {
		this.base.addToHistory?.(text);
	}

	insertTextAtCursor(text: string): void {
		this.base.insertTextAtCursor?.(text);
	}

	getExpandedText(): string {
		return this.base.getExpandedText?.() ?? this.base.getText();
	}

	setAutocompleteProvider(provider: Parameters<NonNullable<EditorComponent["setAutocompleteProvider"]>>[0]): void {
		this.base.setAutocompleteProvider?.(provider);
	}

	setPaddingX(padding: number): void {
		this.base.setPaddingX?.(padding);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.base.setAutocompleteMaxVisible?.(maxVisible);
	}

	dispose(): void {
		this.base.dispose?.();
	}
}

function installPromptallEditorShortcut(ctx: ExtensionContext, deps: PromptallExtensionDeps): void {
	if (!ctx.hasUI) return;
	const previousFactory = ctx.ui.getEditorComponent();

	ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => {
		const base = previousFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
		return new PromptallEditorWrapper(base as PromptallEditorBase, ctx, deps);
	});
}

function isInteractiveTui(ctx: ExtensionContext): boolean {
	const mode = (ctx as { mode?: unknown }).mode;
	if (typeof mode === "string") return mode === "tui";
	return ctx.hasUI;
}

export async function openPromptallHistory(ctx: ExtensionContext, deps: PromptallExtensionDeps = {}): Promise<void> {
	if (!isInteractiveTui(ctx)) {
		ctx.ui.notify("promptall requires interactive TUI mode", "error");
		return;
	}

	let prompts: PromptHistoryItem[];
	try {
		prompts = deps.loadHistory ? await deps.loadHistory(ctx) : await loadPromptHistory(ctx, deps);
	} catch (error) {
		ctx.ui.notify(`Failed to load prompt history: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}

	if (prompts.length === 0) {
		ctx.ui.notify("No prior text prompts found", "warning");
		return;
	}

	const selected = deps.selectPrompt ? await deps.selectPrompt(ctx, prompts) : await selectPromptWithTui(ctx, prompts);
	if (!selected) return;

	ctx.ui.setEditorText(selected.text);
	ctx.ui.notify("Prompt inserted from history. Edit or submit when ready.", "info");
}

export function registerPromptallExtension(pi: ExtensionAPI, deps: PromptallExtensionDeps = {}): void {
	pi.on("session_start", (_event, ctx) => {
		installPromptallEditorShortcut(ctx, deps);
	});

	pi.registerCommand("promptall", {
		description: "Search previous prompts across saved sessions",
		handler: async (_args, ctx) => {
			await openPromptallHistory(ctx, deps);
		},
	});
}

export default function promptallExtension(pi: ExtensionAPI): void {
	registerPromptallExtension(pi);
}
