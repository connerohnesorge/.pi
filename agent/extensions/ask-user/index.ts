/**
 * Ask Tool Extension - Interactive question UI for pi-coding-agent
 *
 * Refactored to use built-in TUI primitives (Container/Text/Spacer/SelectList/Editor)
 * and a custom box border instead of manual ANSI box drawing.
 */

import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Type, type TUnsafe } from "@sinclair/typebox";
import {
   Container,
   type Component,
   decodeKittyPrintable,
   Editor,
   type EditorTheme,
   fuzzyFilter,
   Key,
   type Keybinding,
   type KeybindingsManager,
   Markdown,
   type MarkdownTheme,
   matchesKey,
   type OverlayHandle,
   Spacer,
   Text,
   type TUI,
   truncateToWidth,
   wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
   buildSelectionRowModel,
   type QuestionOption,
   renderSingleSelectRows,
   type SelectionRowModel,
} from "./single-select-layout";

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const ASK_USER_VERSION: string = (_require("./package.json") as { version: string }).version;

/**
 * Emit a flat `{ type: "string", enum: [...] }` JSON Schema instead of the
 * `anyOf`/`oneOf` shape that `Type.Union([Type.Literal()])` produces. Google's
 * function-calling API rejects the union form. Local copy of pi-ai's StringEnum
 * to avoid a peer dependency for one helper.
 */
function StringEnum<const T extends readonly string[]>(
   values: T,
   options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
   return Type.Unsafe<T[number]>({
      type: "string",
      enum: [...values],
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.default !== undefined ? { default: options.default } : {}),
   });
}

/**
 * `getMarkdownTheme()` returns a bag of closures that read through a Proxy
 * over the host's theme singleton. The Proxy only throws on property access,
 * not when the bag itself is constructed — so a naive
 * `try { getMarkdownTheme() } catch {}` silently lets a broken bag escape
 * and crashes mid-render the first time pi-tui's Markdown calls
 * `mdTheme.bold(...)`.
 *
 * That broken-bag scenario shows up whenever this extension's bundled copy
 * of `@earendil-works/pi-coding-agent` is a different module instance than
 * the host's — e.g. an older Pi still on the legacy
 * `@mariozechner/pi-coding-agent` scope (≤ 0.73.1) where npm cannot dedupe
 * across scopes, so our copy's theme singleton is never initialised
 * (`globalThis[Symbol.for("@earendil-works/pi-coding-agent:theme")]` is
 * undefined). See https://github.com/edlsh/pi-ask-user/issues/17.
 *
 * Probe `bold("")` to force the Proxy lookup eagerly; on throw, callers
 * fall back to plain `Text` rendering for context blocks.
 */
function safeMarkdownTheme(): MarkdownTheme | undefined {
   try {
      const md = getMarkdownTheme();
      if (!md) return undefined;
      md.bold("");
      return md;
   } catch {
      return undefined;
   }
}

type AskOptionInput = QuestionOption | string;

type AskDisplayMode = "overlay" | "inline";

interface AskParams {
   question: string;
   context?: string;
   options?: AskOptionInput[];
   allowMultiple?: boolean;
   allowFreeform?: boolean;
   allowComment?: boolean;
   displayMode?: AskDisplayMode;
   overlayToggleKey?: string | null;
   commentToggleKey?: string | null;
   timeout?: number;
}

type AskResponse =
   | {
      kind: "selection";
      selections: string[];
      comment?: string;
   }
   | {
      kind: "freeform";
      text: string;
   };

interface AskToolDetails {
   question: string;
   context?: string;
   options: QuestionOption[];
   response: AskResponse | null;
   cancelled: boolean;
}

type AskUIResult = AskResponse;

function normalizeOptions(options: AskOptionInput[]): QuestionOption[] {
   return options
      .map((option) => {
         if (typeof option === "string") {
            return { title: option };
         }
         if (option && typeof option === "object" && typeof option.title === "string") {
            return { title: option.title, description: option.description };
         }
         return null;
      })
      .filter((option): option is QuestionOption => option !== null);
}

function formatOptionsForMessage(options: QuestionOption[]): string {
   return options
      .map((option, index) => {
         const desc = option.description ? ` — ${option.description}` : "";
         return `${index + 1}. ${option.title}${desc}`;
      })
      .join("\n");
}

function normalizeOptionalComment(text: string | null | undefined): string | undefined {
   const trimmed = text?.trim();
   return trimmed ? trimmed : undefined;
}

function createFreeformResponse(text: string | null | undefined): AskResponse | null {
   const trimmed = text?.trim();
   return trimmed ? { kind: "freeform", text: trimmed } : null;
}

function createSelectionResponse(selections: string[], comment?: string | null): AskResponse | null {
   const normalizedSelections = selections.map((selection) => selection.trim()).filter(Boolean);
   if (normalizedSelections.length === 0) return null;

   const normalizedComment = normalizeOptionalComment(comment);
   return normalizedComment
      ? { kind: "selection", selections: normalizedSelections, comment: normalizedComment }
      : { kind: "selection", selections: normalizedSelections };
}

function formatResponseSummary(response: AskResponse): string {
   if (response.kind === "freeform") return response.text;

   const selections = response.selections.join(", ");
   return response.comment ? `${selections} — ${response.comment}` : selections;
}

function buildCommentPrompt(prompt: string, selections: string[]): string {
   const label = selections.length === 1 ? "Selected option" : "Selected options";
   const lines = selections.map((selection) => `- ${selection}`).join("\n");
   return `${prompt}\n\n${label}:\n${lines}`;
}

function parseDialogSelections(input: string): string[] {
   return input
      .split(",")
      .map((selection) => selection.trim())
      .filter(Boolean);
}

function isCancelledInput(value: unknown): value is null | undefined {
   return value === null || value === undefined;
}

function isSelectionResponse(response: AskResponse): response is Extract<AskResponse, { kind: "selection" }> {
   return response.kind === "selection";
}

const SELECT_LIST_THEME_COLORS = [
   ["selectedPrefix", "accent"],
   ["selectedText", "accent"],
   ["description", "muted"],
   ["scrollInfo", "dim"],
   ["noMatch", "warning"],
] as const;

type SelectListTheme = Record<(typeof SELECT_LIST_THEME_COLORS)[number][0], (text: string) => string>;

function themeStyle(theme: Theme, color: string): (text: string) => string {
   return (text: string) => theme.fg(color, text);
}

function createSelectListTheme(theme: Theme): SelectListTheme {
   const entries = SELECT_LIST_THEME_COLORS.map(([name, color]) => [name, themeStyle(theme, color)]);
   return Object.fromEntries(entries) as SelectListTheme;
}

function createEditorTheme(theme: Theme): EditorTheme {
   return {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: createSelectListTheme(theme),
   };
}

const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;

class BoxBorderTop implements Component {
   private color: (s: string) => string;
   private title?: string;
   private titleColor?: (s: string) => string;
   constructor(color: (s: string) => string, title?: string, titleColor?: (s: string) => string) {
      this.color = color;
      this.title = title;
      this.titleColor = titleColor;
   }
   invalidate(): void { }
   render(width: number): string[] {
      const inner = Math.max(0, width - 2);
      if (!this.title || inner < this.title.length + 4) {
         return [this.color(`╭${"─".repeat(inner)}╮`)];
      }
      const label = ` ${this.title} `;
      const remaining = inner - 1 - label.length;
      const titleStyle = this.titleColor ?? this.color;
      return [
         this.color("╭─") + titleStyle(label) + this.color("─".repeat(Math.max(0, remaining)) + "╮"),
      ];
   }
}

class BoxBorderBottom implements Component {
   private color: (s: string) => string;
   private label?: string;
   private labelColor?: (s: string) => string;
   constructor(color: (s: string) => string, label?: string, labelColor?: (s: string) => string) {
      this.color = color;
      this.label = label;
      this.labelColor = labelColor;
   }
   invalidate(): void { }
   render(width: number): string[] {
      const inner = Math.max(0, width - 2);
      if (!this.label || inner < this.label.length + 4) {
         return [this.color(`╰${"─".repeat(inner)}╯`)];
      }
      const tag = ` ${this.label} `;
      const leftDashes = inner - tag.length - 1;
      const style = this.labelColor ?? this.color;
      return [
         this.color("╰" + "─".repeat(Math.max(0, leftDashes))) + style(tag) + this.color("─╯"),
      ];
   }
}

function formatKeyList(keys: string[]): string {
   return keys.join("/");
}

function keybindingHint(
   theme: Theme,
   keybindings: KeybindingsManager,
   keybinding: Keybinding,
   description: string,
): string {
   return `${theme.fg("dim", formatKeyList(keybindings.getKeys(keybinding)))}${theme.fg("muted", ` ${description}`)}`;
}

function literalHint(theme: Theme, key: string, description: string): string {
   return `${theme.fg("dim", key)}${theme.fg("muted", ` ${description}`)}`;
}

function alternateCancelHint(theme: Theme, keybindings: KeybindingsManager): string | null {
   const alternateCancelKeys = keybindings
      .getKeys("tui.select.cancel")
      .filter((key) => key !== "escape" && key !== "esc");
   return alternateCancelKeys.length > 0
      ? literalHint(theme, formatKeyList(alternateCancelKeys), "cancel")
      : null;
}

function setDimHelpText(helpText: Text, theme: Theme, hints: Array<string | null>): void {
   helpText.setText(theme.fg("dim", hints.filter((hint): hint is string => !!hint).join(" • ")));
}

type ResolvedShortcut =
   | { disabled: false; spec: string; matches: (data: string) => boolean }
   | { disabled: true; spec: null; matches: (data: string) => false };

interface ResolvedAskShortcuts {
   overlayToggle: ResolvedShortcut;
   commentToggle: ResolvedShortcut;
}

const DISABLED_SHORTCUT: ResolvedShortcut = {
   disabled: true,
   spec: null,
   matches: ((_data: string) => false) as (data: string) => false,
};

const SHORTCUT_DISABLE_VALUES = new Set(["off", "none", "disabled", ""]);

function normalizeShortcutSpec(value: string | null | undefined): string | null | undefined {
   if (value === undefined) return undefined;
   if (value === null) return null;
   const trimmed = value.trim().toLowerCase();
   if (SHORTCUT_DISABLE_VALUES.has(trimmed)) return null;
   return trimmed;
}

function isValidShortcutSpec(spec: string): boolean {
   // KeyId is canonical lowercase: modifiers (`ctrl|shift|alt|super`) joined by `+`,
   // plus a base key. We do a light syntactic sanity check; matchesKey() does the rest.
   if (!spec) return false;
   if (!/^[a-z0-9+_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]+$/i.test(spec)) return false;
   if (spec.startsWith("+") || spec.endsWith("+")) return false;
   if (spec.includes("++")) return false;
   return true;
}

function buildShortcut(spec: string): ResolvedShortcut {
   return {
      disabled: false,
      spec,
      matches: (data: string) => matchesKey(data, spec as any),
   };
}

function resolveShortcut(
   paramValue: string | null | undefined,
   envValue: string | undefined,
   defaultSpec: string,
): ResolvedShortcut {
   const candidates: Array<string | null | undefined> = [paramValue, envValue, defaultSpec];
   for (const raw of candidates) {
      const normalized = normalizeShortcutSpec(raw);
      if (normalized === undefined) continue; // not provided, fall through
      if (normalized === null) return DISABLED_SHORTCUT; // explicit disable
      if (isValidShortcutSpec(normalized)) return buildShortcut(normalized);
      // Invalid spec: silently fall through to next candidate.
   }
   return DISABLED_SHORTCUT;
}

type AskMode = "select" | "freeform" | "comment";

type HelpMode = Exclude<AskMode, "select">;

function buildTextInputHelpHints(
   theme: Theme,
   keybindings: KeybindingsManager,
   mode: HelpMode,
   overlayHint: string | null,
): Array<string | null> {
   return [
      keybindingHint(theme, keybindings, "tui.input.submit", mode === "comment" ? "submit/skip" : "submit"),
      keybindingHint(theme, keybindings, "tui.input.newLine", "newline"),
      literalHint(theme, "esc", "back"),
      overlayHint,
      alternateCancelHint(theme, keybindings),
   ];
}

function buildMultiSelectHelpHints(
   theme: Theme,
   keybindings: KeybindingsManager,
   commentHint: string | null,
   overlayHint: string | null,
): Array<string | null> {
   return [
      literalHint(theme, "↑↓", "navigate"),
      literalHint(theme, "space", "toggle"),
      commentHint,
      overlayHint,
      keybindingHint(theme, keybindings, "tui.select.confirm", "submit"),
      keybindingHint(theme, keybindings, "tui.select.cancel", "cancel"),
   ];
}

function buildSingleSelectHelpHints(
   theme: Theme,
   keybindings: KeybindingsManager,
   commentHint: string | null,
   overlayHint: string | null,
): Array<string | null> {
   return [
      literalHint(theme, "type", "filter"),
      keybindingHint(theme, keybindings, "tui.editor.deleteCharBackward", "erase"),
      literalHint(theme, "↑↓", "navigate"),
      commentHint,
      overlayHint,
      keybindingHint(theme, keybindings, "tui.select.confirm", "select"),
      literalHint(theme, "esc", "clear/cancel"),
      alternateCancelHint(theme, keybindings),
   ];
}

const ASK_OVERLAY_MAX_HEIGHT_RATIO = 0.85;
const ASK_OVERLAY_WIDTH = "92%";
const ASK_OVERLAY_MIN_WIDTH = 40;
const SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH = 84;
const SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH = 32;
const SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH = 28;
const SINGLE_SELECT_SPLIT_PANE_SEPARATOR = " │ ";
const FREEFORM_SENTINEL = "\u270f\ufe0f Type custom response...";
const COMMENT_TOGGLE_LABEL = "Add extra context after selection";
const DEFAULT_OVERLAY_TOGGLE_KEY = "alt+o";
const DEFAULT_COMMENT_TOGGLE_KEY = "ctrl+g";

// Vim-style aliases for navigating option lists. ctrl+j/k are safe in the
// searchable single-select because they don't collide with fuzzy-search input.
const VIM_SELECT_UP_KEY = Key.ctrl("k");
const VIM_SELECT_DOWN_KEY = Key.ctrl("j");

function matchesSelectUp(data: string, keybindings: KeybindingsManager): boolean {
   return (
      keybindings.matches(data, "tui.select.up") ||
      matchesKey(data, Key.shift("tab")) ||
      matchesKey(data, VIM_SELECT_UP_KEY)
   );
}

function matchesSelectDown(data: string, keybindings: KeybindingsManager): boolean {
   return (
      keybindings.matches(data, "tui.select.down") ||
      matchesKey(data, Key.tab) ||
      matchesKey(data, VIM_SELECT_DOWN_KEY)
   );
}


function numberedInputIndex(data: string, optionCount: number): number | null {
   const numMatch = data.match(/^[1-9]$/);
   if (!numMatch) return null;

   const index = Number.parseInt(numMatch[0], 10) - 1;
   return index >= 0 && index < optionCount ? index : null;
}

function wrapSelectionIndex(index: number, delta: -1 | 1, count: number): number {
   if (count <= 0) return 0;
   if (delta < 0) return index === 0 ? count - 1 : index - 1;
   return index === count - 1 ? 0 : index + 1;
}

function centeredVisibleRange(selectedIndex: number, count: number, maxVisible: number): { start: number; end: number } {
   const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), count - maxVisible));
   return { start, end: Math.min(start + maxVisible, count) };
}

interface MultiSelectRenderRowParams {
   index: number;
   selectedIndex: number;
   rowModel: SelectionRowModel;
   options: QuestionOption[];
   checked: ReadonlySet<number>;
   commentEnabled: boolean;
   theme: Theme;
   width: number;
}

function renderMultiSelectRow(params: MultiSelectRenderRowParams): string[] {
   const { index, selectedIndex, rowModel, options, checked, commentEnabled, theme, width } = params;
   const isSelected = index === selectedIndex;
   const prefix = renderMultiSelectPrefix(isSelected, theme);

   if (rowModel.isCommentToggleRow(index)) {
      return renderMultiSelectCommentToggleRow({ commentEnabled, isSelected, prefix, theme, width });
   }
   if (rowModel.isFreeformRow(index)) return renderMultiSelectFreeformRow(prefix, theme, width);
   return renderMaybeMultiSelectOptionRow({ index, option: options[index], checked, isSelected, prefix, theme, width });
}

function renderMultiSelectPrefix(isSelected: boolean, theme: Theme): string {
   return isSelected ? theme.fg("accent", "→") : " ";
}

function renderMultiSelectCommentToggleRow(params: {
   commentEnabled: boolean;
   isSelected: boolean;
   prefix: string;
   theme: Theme;
   width: number;
}): string[] {
   const { commentEnabled, isSelected, prefix, theme, width } = params;
   const checkbox = commentEnabled ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
   const labelColor = isSelected ? "accent" : "text";
   const label = theme.fg(labelColor, theme.bold(COMMENT_TOGGLE_LABEL));
   return [truncateToWidth(`${prefix}   ${checkbox} ${label}`, width, "")];
}

function renderMultiSelectFreeformRow(prefix: string, theme: Theme, width: number): string[] {
   const label = theme.fg("text", theme.bold("Type something."));
   const desc = theme.fg("muted", "Enter a custom response");
   return [truncateToWidth(`${prefix}   ${label} ${theme.fg("dim", "—")} ${desc}`, width, "")];
}

function renderMaybeMultiSelectOptionRow(params: {
   index: number;
   option: QuestionOption | undefined;
   checked: ReadonlySet<number>;
   isSelected: boolean;
   prefix: string;
   theme: Theme;
   width: number;
}): string[] {
   return params.option ? renderMultiSelectOptionRow({ ...params, option: params.option }) : [];
}

function renderMultiSelectOptionRow(params: {
   index: number;
   option: QuestionOption;
   checked: ReadonlySet<number>;
   isSelected: boolean;
   prefix: string;
   theme: Theme;
   width: number;
}): string[] {
   const { index, option, checked, isSelected, prefix, theme, width } = params;
   const checkbox = checked.has(index) ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
   const num = theme.fg("dim", `${index + 1}.`);
   const titleColor = isSelected ? "accent" : "text";
   const title = theme.fg(titleColor, theme.bold(option.title));
   const lines = [truncateToWidth(`${prefix} ${num} ${checkbox} ${title}`, width, "")];

   if (option.description) appendMultiSelectDescriptionLines(lines, option.description, theme, width);
   return lines;
}

function appendMultiSelectDescriptionLines(lines: string[], description: string, theme: Theme, width: number): void {
   const indent = "      ";
   for (const wrappedLine of wrapTextWithAnsi(description, Math.max(10, width - indent.length))) {
      lines.push(truncateToWidth(indent + theme.fg("muted", wrappedLine), width, ""));
   }
}

function renderMultiSelectRows(params: Omit<MultiSelectRenderRowParams, "index"> & { start: number; end: number }): string[] {
   const { start, end, ...rowParams } = params;
   return Array.from({ length: end - start }, (_, offset) => renderMultiSelectRow({ ...rowParams, index: start + offset })).flat();
}

function renderMultiSelectPositionLine(
   start: number,
   end: number,
   count: number,
   selectedIndex: number,
   theme: Theme,
   width: number,
): string[] {
   return start > 0 || end < count
      ? [theme.fg("dim", truncateToWidth(`  (${selectedIndex + 1}/${count})`, width, ""))]
      : [];
}

function isAnsiControlCharacter(code: number): boolean {
   return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

function decodePlainPrintableInput(data: string): string | null {
   const [character, extra] = [...data];
   if (!character || extra !== undefined) return null;
   return isAnsiControlCharacter(character.charCodeAt(0)) ? null : character;
}

function buildSelectedOptionPreviewMarkdown(option: QuestionOption | undefined, searchQuery: string): string {
   if (!option) return "*No option selected*\n";

   let md = `## ${option.title}\n\n`;
   md += option.description?.trim()
      ? `${option.description}\n`
      : "*No additional details provided for this option.*\n";
   md += "\n---\n\nPress `Enter` to select this option.\n";
   if (searchQuery) md += `\n> Filter: \`${searchQuery}\`\n`;
   return md;
}

function buildPreviewMarkdown(params: {
   rowModel: SelectionRowModel;
   selectedIndex: number;
   filteredOptions: QuestionOption[];
   commentEnabled: boolean;
   searchQuery: string;
}): string {
   const { rowModel, selectedIndex, filteredOptions, commentEnabled, searchQuery } = params;

   if (rowModel.isCommentToggleRow(selectedIndex)) {
      return [
         "## Additional context",
         "",
         `Currently: **${commentEnabled ? "Enabled" : "Disabled"}**`,
         "",
         "Turn this on when the selected option needs extra explanation before the tool submits.",
      ].join("\n");
   }

   if (rowModel.isFreeformRow(selectedIndex)) {
      return [
         "## Custom response",
         "",
         "Open the editor to write **any** answer.",
         "",
         "*Use this when none of the listed options fit.*",
         searchQuery ? `\n> Current filter: \`${searchQuery}\`` : "",
      ].join("\n");
   }

   return buildSelectedOptionPreviewMarkdown(filteredOptions[selectedIndex], searchQuery);
}

function renderPreviewMarkdown(md: string, width: number, mdTheme: MarkdownTheme | undefined): string[] {
   if (mdTheme) return new Markdown(md.trim(), 0, 0, mdTheme).render(width);
   return wrapTextWithAnsi(md.trim(), Math.max(10, width)).map((line) => truncateToWidth(line, width, ""));
}

function trimTrailingBlankLines(lines: string[]): string[] {
   const trimmed = [...lines];
   while (trimmed.length > 0 && trimmed[trimmed.length - 1]?.trim() === "") trimmed.pop();
   return trimmed;
}

function limitLinesWithEllipsis(lines: string[], maxLines: number, width: number, theme: Theme): string[] {
   if (lines.length <= maxLines) return lines;
   const ellipsis = truncateToWidth(theme.fg("dim", "…"), width, "");
   if (maxLines === 1) return [ellipsis];
   return [...lines.slice(0, maxLines - 1), ellipsis];
}


type MultiSelectInputAction =
   | { kind: "cancel" }
   | { kind: "toggle-comment" }
   | { kind: "move"; delta: -1 | 1 }
   | { kind: "toggle-numbered"; index: number }
   | { kind: "space" }
   | { kind: "confirm" }
   | { kind: "ignore" };

function cancelAction(data: string, keybindings: KeybindingsManager): MultiSelectInputAction | null {
   return keybindings.matches(data, "tui.select.cancel") ? { kind: "cancel" } : null;
}

function commentToggleAction(
   data: string,
   allowComment: boolean,
   commentToggle: ResolvedShortcut,
): MultiSelectInputAction | null {
   const enabled = allowComment && !commentToggle.disabled;
   return enabled && commentToggle.matches(data) ? { kind: "toggle-comment" } : null;
}

function moveAction(data: string, keybindings: KeybindingsManager): MultiSelectInputAction | null {
   if (matchesSelectUp(data, keybindings)) return { kind: "move", delta: -1 };
   if (matchesSelectDown(data, keybindings)) return { kind: "move", delta: 1 };
   return null;
}

function numberedAction(data: string, optionCount: number): MultiSelectInputAction | null {
   const index = numberedInputIndex(data, optionCount);
   return index === null ? null : { kind: "toggle-numbered", index };
}

function spaceAction(data: string): MultiSelectInputAction | null {
   return matchesKey(data, Key.space) ? { kind: "space" } : null;
}

function confirmAction(data: string, keybindings: KeybindingsManager): MultiSelectInputAction | null {
   return keybindings.matches(data, "tui.select.confirm") ? { kind: "confirm" } : null;
}

function resolveMultiSelectInputAction(params: {
   data: string;
   optionCount: number;
   allowComment: boolean;
   commentToggle: ResolvedShortcut;
   keybindings: KeybindingsManager;
}): MultiSelectInputAction {
   const { data, optionCount, allowComment, commentToggle, keybindings } = params;
   const candidates = [
      cancelAction(data, keybindings),
      commentToggleAction(data, allowComment, commentToggle),
      moveAction(data, keybindings),
      numberedAction(data, optionCount),
      spaceAction(data),
      confirmAction(data, keybindings),
   ];
   return candidates.find((candidate): candidate is MultiSelectInputAction => candidate !== null) ?? { kind: "ignore" };
}

function buildCustomUIOptions(
   displayMode: AskDisplayMode,
   onHandle?: (handle: OverlayHandle) => void,
) {
   switch (displayMode) {
      case "inline":
         return undefined;
      case "overlay":
         return {
            overlay: true,
            overlayOptions: {
               anchor: "center" as const,
               width: ASK_OVERLAY_WIDTH,
               minWidth: ASK_OVERLAY_MIN_WIDTH,
               maxHeight: "85%",
               margin: 1,
            },
            ...(onHandle ? { onHandle } : {}),
         };
      default: {
         const _exhaustive: never = displayMode;
         void _exhaustive;
         return {
            overlay: true,
            overlayOptions: {
               anchor: "center" as const,
               width: ASK_OVERLAY_WIDTH,
               minWidth: ASK_OVERLAY_MIN_WIDTH,
               maxHeight: "85%",
               margin: 1,
            },
            ...(onHandle ? { onHandle } : {}),
         };
      }
   }
}

abstract class SelectionListBase<TResult> implements Component {
   protected options: QuestionOption[];
   protected allowFreeform: boolean;
   protected allowComment: boolean;
   protected theme: Theme;
   protected keybindings: KeybindingsManager;
   protected commentToggle: ResolvedShortcut;
   protected commentEnabled = false;
   protected cachedWidth?: number;
   protected cachedLines?: string[];

   public onCancel?: () => void;
   public onSubmit?: (result: TResult) => void;
   public onEnterFreeform?: () => void;

   constructor(
      options: QuestionOption[],
      allowFreeform: boolean,
      allowComment: boolean,
      theme: Theme,
      keybindings: KeybindingsManager,
      commentToggle: ResolvedShortcut,
   ) {
      this.options = options;
      this.allowFreeform = allowFreeform;
      this.allowComment = allowComment;
      this.theme = theme;
      this.keybindings = keybindings;
      this.commentToggle = commentToggle;
   }

   public isCommentEnabled(): boolean {
      return this.commentEnabled;
   }

   abstract render(width: number): string[];

   invalidate(): void {
      this.cachedWidth = undefined;
      this.cachedLines = undefined;
   }

   protected toggleComment(): void {
      if (!this.allowComment) return;
      this.commentEnabled = !this.commentEnabled;
      this.invalidate();
   }
}

class MultiSelectList extends SelectionListBase<string[]> {
   private selectedIndex = 0;
   private checked = new Set<number>();

   private getRowModel() {
      return buildSelectionRowModel({
         optionCount: this.options.length,
         allowComment: this.allowComment,
         allowFreeform: this.allowFreeform,
      });
   }

   private toggle(index: number): void {
      if (index < 0 || index >= this.options.length) return;
      if (this.checked.has(index)) this.checked.delete(index);
      else this.checked.add(index);
   }

   private handleActionRow(rowModel: SelectionRowModel): boolean {
      if (rowModel.isCommentToggleRow(this.selectedIndex)) {
         this.toggleComment();
         return true;
      }
      if (rowModel.isFreeformRow(this.selectedIndex)) {
         this.onEnterFreeform?.();
         return true;
      }
      return false;
   }

   private selectedTitles(): string[] {
      const titles = Array.from(this.checked)
         .sort((a, b) => a - b)
         .map((index) => this.options[index]?.title)
         .filter((title): title is string => !!title);
      const fallback = this.options[this.selectedIndex]?.title;
      return titles.length > 0 ? titles : fallback ? [fallback] : [];
   }

   handleInput(data: string): void {
      const rowModel = this.getRowModel();
      const action = resolveMultiSelectInputAction({
         data,
         optionCount: this.options.length,
         allowComment: this.allowComment,
         commentToggle: this.commentToggle,
         keybindings: this.keybindings,
      });
      this.applyInputAction(action, rowModel);
   }

   private applyInputAction(action: MultiSelectInputAction, rowModel: SelectionRowModel): void {
      const count = rowModel.count;
      const handlers: Record<MultiSelectInputAction["kind"], () => void> = {
         cancel: () => this.onCancel?.(),
         "toggle-comment": () => this.toggleComment(),
         move: () => { if (action.kind === "move") this.moveSelection(action.delta, count); },
         "toggle-numbered": () => { if (action.kind === "toggle-numbered") this.toggleNumberedOption(action.index, count); },
         space: () => this.toggleCurrentRow(rowModel),
         confirm: () => this.confirmCurrentSelection(rowModel),
         ignore: () => undefined,
      };

      if (count === 0) handlers.cancel();
      else handlers[action.kind]();
   }

   private toggleCurrentRow(rowModel: SelectionRowModel): void {
      if (this.handleActionRow(rowModel)) return;
      this.toggle(this.selectedIndex);
      this.invalidate();
   }

   private confirmCurrentSelection(rowModel: SelectionRowModel): void {
      if (this.handleActionRow(rowModel)) return;
      const result = this.selectedTitles();
      if (result.length > 0) this.onSubmit?.(result);
      else this.onCancel?.();
   }

   private moveSelection(delta: -1 | 1, count: number): void {
      this.selectedIndex = wrapSelectionIndex(this.selectedIndex, delta, count);
      this.invalidate();
   }

   private toggleNumberedOption(index: number, count: number): void {
      this.toggle(index);
      this.selectedIndex = Math.min(index, count - 1);
      this.invalidate();
   }

   render(width: number): string[] {
      if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

      const rowModel = this.getRowModel();
      const count = rowModel.count;
      if (count === 0) return this.cacheLines(width, [this.theme.fg("warning", "No options")]);

      const maxVisible = Math.min(count, 10);
      const { start, end } = centeredVisibleRange(this.selectedIndex, count, maxVisible);
      const lines = [
         ...renderMultiSelectRows({
            start,
            end,
            selectedIndex: this.selectedIndex,
            rowModel,
            options: this.options,
            checked: this.checked,
            commentEnabled: this.commentEnabled,
            theme: this.theme,
            width,
         }),
         ...renderMultiSelectPositionLine(start, end, count, this.selectedIndex, this.theme, width),
      ];

      return this.cacheLines(width, lines);
   }

   private cacheLines(width: number, lines: string[]): string[] {
      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
   }
}

class WrappedSingleSelectList extends SelectionListBase<string> {
   private selectedIndex = 0;
   private searchQuery = "";
   private maxVisibleRows = 12;

   setMaxVisibleRows(rows: number): void {
      const next = Math.max(1, Math.floor(rows));
      if (next !== this.maxVisibleRows) {
         this.maxVisibleRows = next;
         this.invalidate();
      }
   }

   private getFilteredOptions(): QuestionOption[] {
      return fuzzyFilter(this.options, this.searchQuery, (option) => `${option.title} ${option.description ?? ""}`);
   }

   private getRowModel(filteredOptions: QuestionOption[]) {
      return buildSelectionRowModel({
         optionCount: filteredOptions.length,
         allowComment: this.allowComment,
         allowFreeform: this.allowFreeform,
      });
   }

   private setSearchQuery(query: string): void {
      this.searchQuery = query;
      this.selectedIndex = 0;
      this.invalidate();
   }

   private popSearchCharacter(): void {
      if (!this.searchQuery) return;
      const characters = [...this.searchQuery];
      characters.pop();
      this.setSearchQuery(characters.join(""));
   }

   private getPrintableInput(data: string): string | null {
      return decodeKittyPrintable(data) ?? decodePlainPrintableInput(data);
   }

   private styleListLine(line: string, width: number, isSelected: boolean): string {
      const trimmed = line.trim();

      if (trimmed.startsWith("(")) {
         return truncateToWidth(this.theme.fg("dim", line), width, "");
      }

      if (isSelected) {
         return truncateToWidth(this.theme.fg("accent", this.theme.bold(line)), width, "");
      }

      if (line.startsWith("      ")) {
         return truncateToWidth(this.theme.fg("muted", line), width, "");
      }

      if (line.startsWith("→")) {
         return truncateToWidth(this.theme.fg("accent", this.theme.bold(line)), width, "");
      }

      return truncateToWidth(this.theme.fg("text", line), width, "");
   }

   private getSplitPaneWidths(width: number): { left: number; right: number } | null {
      if (width < SINGLE_SELECT_SPLIT_PANE_MIN_WIDTH) return null;

      const availableWidth = width - SINGLE_SELECT_SPLIT_PANE_SEPARATOR.length;
      if (availableWidth < SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH + SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) {
         return null;
      }

      const preferredLeftWidth = Math.floor(availableWidth * 0.42);
      const left = Math.max(
         SINGLE_SELECT_SPLIT_PANE_LEFT_MIN_WIDTH,
         Math.min(preferredLeftWidth, availableWidth - SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH),
      );
      const right = availableWidth - left;

      if (right < SINGLE_SELECT_SPLIT_PANE_RIGHT_MIN_WIDTH) return null;
      return { left, right };
   }

   private buildListLines(width: number, filteredOptions: QuestionOption[], hideDescriptions = false): string[] {
      const lines: string[] = [];
      const count = this.getRowModel(filteredOptions).count;
      const searchValue = this.searchQuery ? this.theme.fg("text", this.searchQuery) : this.theme.fg("dim", "type to filter");
      lines.push(truncateToWidth(`${this.theme.fg("accent", "Filter:")} ${searchValue}`, width, ""));

      if (this.searchQuery && filteredOptions.length === 0) {
         lines.push(truncateToWidth(this.theme.fg("warning", "No matching options"), width, ""));
      }

      if (count === 0) {
         if (!this.searchQuery) {
            lines.push(truncateToWidth(this.theme.fg("warning", "No options"), width, ""));
         }
         return lines.slice(0, this.maxVisibleRows);
      }

      const maxRows = Math.max(1, this.maxVisibleRows - lines.length);
      const optionRows = renderSingleSelectRows({
         options: filteredOptions,
         selectedIndex: this.selectedIndex,
         width,
         allowFreeform: this.allowFreeform,
         allowComment: this.allowComment,
         commentEnabled: this.commentEnabled,
         maxRows,
         hideDescriptions,
      });
      const optionLines = optionRows.map((row) => this.styleListLine(row.line, width, row.selected));

      lines.push(...optionLines);
      return lines.slice(0, this.maxVisibleRows);
   }

   private buildPreviewLines(width: number, filteredOptions: QuestionOption[], maxLines: number): string[] {
      if (maxLines <= 0) return [];

      const md = buildPreviewMarkdown({
         rowModel: this.getRowModel(filteredOptions),
         selectedIndex: this.selectedIndex,
         filteredOptions,
         commentEnabled: this.commentEnabled,
         searchQuery: this.searchQuery,
      });
      const lines = trimTrailingBlankLines(renderPreviewMarkdown(md, width, safeMarkdownTheme()));
      return limitLinesWithEllipsis(lines, maxLines, width, this.theme);
   }

   private moveSelection(delta: -1 | 1, count: number): void {
      this.selectedIndex = wrapSelectionIndex(this.selectedIndex, delta, count);
      this.invalidate();
   }

   private selectNumberedOption(data: string, filteredOptions: QuestionOption[]): boolean {
      const index = numberedInputIndex(data, filteredOptions.length);
      if (index === null) return false;

      this.selectedIndex = index;
      this.invalidate();
      return true;
   }

   private confirmSelectedOption(filteredOptions: QuestionOption[]): void {
      const result = filteredOptions[this.selectedIndex]?.title;
      if (result) this.onSubmit?.(result);
      else this.onCancel?.();
   }

   handleInput(data: string): void {
      handleWrappedSingleSelectInput(this, data);
   }

   render(width: number): string[] {
      if (this.cachedLines && this.cachedWidth === width) {
         return this.cachedLines;
      }

      const filteredOptions = this.getFilteredOptions();
      const count = this.getRowModel(filteredOptions).count;
      this.selectedIndex = count > 0 ? Math.max(0, Math.min(this.selectedIndex, count - 1)) : 0;

      const splitPane = this.getSplitPaneWidths(width);
      let lines: string[];

      if (!splitPane) {
         lines = this.buildListLines(width, filteredOptions);
      } else {
         const listLines = this.buildListLines(splitPane.left, filteredOptions, true);
         const previewLines = this.buildPreviewLines(splitPane.right, filteredOptions, this.maxVisibleRows);
         const rowCount = Math.min(this.maxVisibleRows, Math.max(listLines.length, previewLines.length));
         const separator = this.theme.fg("dim", SINGLE_SELECT_SPLIT_PANE_SEPARATOR);
         lines = Array.from({ length: rowCount }, (_, index) => {
            const left = truncateToWidth(listLines[index] ?? "", splitPane.left, "", true);
            const right = truncateToWidth(previewLines[index] ?? "", splitPane.right, "");
            return `${left}${separator}${right}`;
         });
      }

      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
   }
}

function handleWrappedSingleSelectInput(list: any, data: string): void {
   if (handleWrappedSingleSelectGlobalInput(list, data)) return;

   const filteredOptions = list.getFilteredOptions();
   const rowModel = list.getRowModel(filteredOptions);
   const count = rowModel.count;

   if (handleWrappedSingleSelectListInput(list, data, filteredOptions, rowModel, count)) return;
   handleWrappedSingleSelectSearchInput(list, data);
}

function handleWrappedSingleSelectGlobalInput(list: any, data: string): boolean {
   return [
      clearWrappedSingleSelectSearch,
      cancelWrappedSingleSelect,
      toggleWrappedSingleSelectComment,
   ].some((handler) => handler(list, data));
}

function clearWrappedSingleSelectSearch(list: any, data: string): boolean {
   if (!list.searchQuery || !matchesKey(data, Key.escape)) return false;
   list.setSearchQuery("");
   return true;
}

function cancelWrappedSingleSelect(list: any, data: string): boolean {
   if (!list.keybindings.matches(data, "tui.select.cancel")) return false;
   list.onCancel?.();
   return true;
}

function toggleWrappedSingleSelectComment(list: any, data: string): boolean {
   const enabled = list.allowComment && !list.commentToggle.disabled;
   if (!enabled || !list.commentToggle.matches(data)) return false;
   list.toggleComment();
   return true;
}

function handleWrappedSingleSelectListInput(
   list: any,
   data: string,
   filteredOptions: QuestionOption[],
   rowModel: SelectionRowModel,
   count: number,
): boolean {
   if (handleWrappedSingleSelectMovement(list, data, count)) return true;
   if (list.selectNumberedOption(data, filteredOptions)) return true;
   if (handleWrappedSingleSelectActivation(list, data, rowModel, filteredOptions, count)) return true;
   if (matchesBackspace(data, list.keybindings)) return callAndHandle(() => list.popSearchCharacter());
   return false;
}

function handleWrappedSingleSelectMovement(list: any, data: string, count: number): boolean {
   if (count <= 0) return false;
   if (matchesSelectUp(data, list.keybindings)) return callAndHandle(() => list.moveSelection(-1, count));
   if (matchesSelectDown(data, list.keybindings)) return callAndHandle(() => list.moveSelection(1, count));
   return false;
}

function handleWrappedSingleSelectActivation(
   list: any,
   data: string,
   rowModel: SelectionRowModel,
   filteredOptions: QuestionOption[],
   count: number,
): boolean {
   if (count <= 0) return false;
   if (matchesKey(data, Key.space) && rowModel.isCommentToggleRow(list.selectedIndex)) return callAndHandle(() => list.toggleComment());
   if (list.keybindings.matches(data, "tui.select.confirm")) return callAndHandle(() => confirmWrappedSingleSelect(list, rowModel, filteredOptions));
   return false;
}

function matchesBackspace(data: string, keybindings: KeybindingsManager): boolean {
   return keybindings.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, Key.backspace);
}

function handleWrappedSingleSelectSearchInput(list: any, data: string): void {
   const printableInput = list.getPrintableInput(data);
   if (printableInput) list.setSearchQuery(list.searchQuery + printableInput);
}

function callAndHandle(action: () => void): true {
   action();
   return true;
}

function confirmWrappedSingleSelect(list: any, rowModel: SelectionRowModel, filteredOptions: QuestionOption[]): void {
   if (rowModel.isCommentToggleRow(list.selectedIndex)) return list.toggleComment();
   if (rowModel.isFreeformRow(list.selectedIndex)) return list.onEnterFreeform?.();
   return list.confirmSelectedOption(filteredOptions);
}

/**
 * Interactive ask UI. Uses a root Container for layout and swaps the center
 * component between SelectList/MultiSelectList and an Editor (freeform mode).
 */
class AskComponent extends Container {
   private question: string;
   private context?: string;
   private options: QuestionOption[];
   private allowMultiple: boolean;
   private allowFreeform: boolean;
   private allowComment: boolean;
   private displayMode: AskDisplayMode;
   private tui: TUI;
   private theme: Theme;
   private keybindings: KeybindingsManager;
   private shortcuts: ResolvedAskShortcuts;
   private onDone: (result: AskUIResult | null) => void;

   private mode: AskMode = "select";
   private pendingSelections: string[] = [];
   private freeformDraft = "";
   private commentDraft = "";

   // Static layout components
   private titleText: Text;
   private questionText: Text;
   private contextComponent?: Component;
   private modeContainer: Container;
   private helpText: Text;

   // Mode components
   private singleSelectList?: WrappedSingleSelectList;
   private multiSelectList?: MultiSelectList;
   private editor?: Editor;

   // Focusable - propagate to Editor for IME cursor positioning
   private _focused = false;
   get focused(): boolean {
      return this._focused;
   }
   set focused(value: boolean) {
      this._focused = value;
      if (this.editor && (this.mode === "freeform" || this.mode === "comment")) {
         (this.editor as any).focused = value;
      }
   }

   constructor(
      question: string,
      context: string | undefined,
      options: QuestionOption[],
      allowMultiple: boolean,
      allowFreeform: boolean,
      allowComment: boolean,
      displayMode: AskDisplayMode,
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      shortcuts: ResolvedAskShortcuts,
      onDone: (result: AskUIResult | null) => void,
   ) {
      super();

      this.question = question;
      this.context = context;
      this.options = options;
      this.allowMultiple = allowMultiple;
      this.allowFreeform = allowFreeform;
      this.allowComment = allowComment;
      this.displayMode = displayMode;
      this.tui = tui;
      this.theme = theme;
      this.keybindings = keybindings;
      this.shortcuts = shortcuts;
      this.onDone = onDone;

      // Layout skeleton
      this.addChild(new BoxBorderTop(
         (s: string) => theme.fg("accent", s),
         "ask_user",
         (s: string) => theme.fg("dim", theme.bold(s)),
      ));
      this.addChild(new Spacer(1));

      this.titleText = new Text("", 1, 0);
      this.addChild(this.titleText);
      this.addChild(new Spacer(1));

      this.questionText = new Text("", 1, 0);
      this.addChild(this.questionText);

      if (this.context) {
         this.addChild(new Spacer(1));
         const mdTheme = safeMarkdownTheme();
         if (mdTheme) {
            this.contextComponent = new Markdown("", 1, 0, mdTheme);
         } else {
            this.contextComponent = new Text("", 1, 0);
         }
         this.addChild(this.contextComponent);
      }

      this.addChild(new Spacer(1));

      this.modeContainer = new Container();
      this.addChild(this.modeContainer);

      this.addChild(new Spacer(1));
      this.helpText = new Text("", 1, 0);
      this.addChild(this.helpText);

      this.addChild(new Spacer(1));
      this.addChild(new BoxBorderBottom(
         (s: string) => theme.fg("accent", s),
         `v${ASK_USER_VERSION}`,
         (s: string) => theme.fg("dim", s),
      ));

      this.updateStaticText();
      this.showSelectMode();
   }

   override invalidate(): void {
      super.invalidate();
      this.updateStaticText();
      this.updateHelpText();
   }

   override render(width: number): string[] {
      const innerWidth = Math.max(1, width - BOX_BORDER_OVERHEAD);

      if (this.mode === "select" && !this.allowMultiple) {
         const overlayMaxHeight = Math.max(12, Math.floor(this.tui.terminal.rows * ASK_OVERLAY_MAX_HEIGHT_RATIO));
         const staticLines = this.countStaticLines(innerWidth);
         const availableOptionRows = Math.max(4, overlayMaxHeight - staticLines);
         this.ensureSingleSelectList().setMaxVisibleRows(availableOptionRows);
      }

      // Render children at the inner width (excluding side border characters)
      const rawLines = super.render(innerWidth);

      // First and last lines are the top/bottom box borders — pass through at full width.
      // All inner lines get wrapped with side borders.
      const borderColor = (s: string) => this.theme.fg("accent", s);
      const titleColor = (s: string) => this.theme.fg("dim", this.theme.bold(s));
      return rawLines.map((line, index) => {
         if (index === 0 || index === rawLines.length - 1) {
            // Box top/bottom borders already rendered at innerWidth — re-render at full width
            if (index === 0) return new BoxBorderTop(borderColor, "ask_user", titleColor).render(width)[0];
            return new BoxBorderBottom(borderColor, `v${ASK_USER_VERSION}`, (s: string) => this.theme.fg("dim", s)).render(width)[0];
         }
         const padded = truncateToWidth(line, innerWidth, "", true);
         return `${borderColor(BOX_BORDER_LEFT)}${padded}${borderColor(BOX_BORDER_RIGHT)}`;
      });
   }

   private countWrappedLines(text: string, width: number): number {
      return Math.max(1, wrapTextWithAnsi(text, Math.max(10, width - 2)).length);
   }

   private countStaticLines(width: number): number {
      const titleLines = 1;
      const questionLines = this.countWrappedLines(this.question, width);
      const contextLines = this.context ? 1 + this.countWrappedLines(this.context, width) : 0;
      const helpLines = 1;
      const borderLines = 2;
      const spacerLines = this.context ? 6 : 5;
      return borderLines + spacerLines + titleLines + questionLines + contextLines + helpLines;
   }

   private updateStaticText(): void {
      const theme = this.theme;
      const title = this.mode === "comment" ? "Optional comment" : "Question";
      this.titleText.setText(theme.fg("accent", theme.bold(title)));
      this.questionText.setText(theme.fg("text", theme.bold(this.question)));
      if (this.contextComponent && this.context) {
         if (this.contextComponent instanceof Markdown) {
            (this.contextComponent as Markdown).setText(
               `**Context:**\n${this.context}`,
            );
         } else {
            (this.contextComponent as Text).setText(
               `${theme.fg("accent", theme.bold("Context:"))}\n${theme.fg("dim", this.context)}`,
            );
         }
      }
   }

   private updateHelpText(): void {
      const theme = this.theme;
      const overlayHint = this.displayMode === "overlay" && !this.shortcuts.overlayToggle.disabled
         ? literalHint(theme, this.shortcuts.overlayToggle.spec, "hide")
         : null;
      const commentHint = this.allowComment && !this.shortcuts.commentToggle.disabled
         ? literalHint(theme, this.shortcuts.commentToggle.spec, "toggle context")
         : null;

      const hints = this.mode === "freeform" || this.mode === "comment"
         ? buildTextInputHelpHints(theme, this.keybindings, this.mode, overlayHint)
         : this.allowMultiple
            ? buildMultiSelectHelpHints(theme, this.keybindings, commentHint, overlayHint)
            : buildSingleSelectHelpHints(theme, this.keybindings, commentHint, overlayHint);

      setDimHelpText(this.helpText, theme, hints);
   }

   private ensureSingleSelectList(): WrappedSingleSelectList {
      if (this.singleSelectList) return this.singleSelectList;

      const list = new WrappedSingleSelectList(
         this.options,
         this.allowFreeform,
         this.allowComment,
         this.theme,
         this.keybindings,
         this.shortcuts.commentToggle,
      );
      list.onSubmit = (result) => this.handleSelectionSubmit([result], list.isCommentEnabled());
      list.onCancel = () => this.onDone(null);
      list.onEnterFreeform = () => this.showFreeformMode();

      this.singleSelectList = list;
      return list;
   }

   private ensureMultiSelectList(): MultiSelectList {
      if (this.multiSelectList) return this.multiSelectList;

      const list = new MultiSelectList(
         this.options,
         this.allowFreeform,
         this.allowComment,
         this.theme,
         this.keybindings,
         this.shortcuts.commentToggle,
      );
      list.onCancel = () => this.onDone(null);
      list.onSubmit = (result) => this.handleSelectionSubmit(result, list.isCommentEnabled());
      list.onEnterFreeform = () => this.showFreeformMode();

      this.multiSelectList = list;
      return list;
   }

   private ensureEditor(): Editor {
      if (this.editor) return this.editor;
      const editor = new Editor(this.tui, createEditorTheme(this.theme));
      editor.disableSubmit = false;
      editor.onSubmit = (text: string) => {
         this.handleEditorSubmit(text);
      };
      this.editor = editor;
      return editor;
   }

   private saveEditorDraft(): void {
      if (!this.editor) return;
      const getText = (this.editor as any).getText;
      if (typeof getText !== "function") return;

      const currentText = String(getText.call(this.editor) ?? "");
      if (this.mode === "freeform") {
         this.freeformDraft = currentText;
      } else if (this.mode === "comment") {
         this.commentDraft = currentText;
      }
   }

   private setEditorText(text: string): void {
      const editor = this.ensureEditor();
      const setText = (editor as any).setText;
      if (typeof setText === "function") {
         setText.call(editor, text);
      }
   }

   private handleSelectionSubmit(selections: string[], wantsComment: boolean): void {
      if (this.allowComment && wantsComment) {
         this.pendingSelections = selections;
         this.commentDraft = "";
         this.showCommentMode();
         return;
      }

      this.onDone(createSelectionResponse(selections));
   }

   private handleEditorSubmit(text: string): void {
      if (this.mode === "freeform") {
         this.onDone(createFreeformResponse(text));
         return;
      }

      if (this.mode === "comment") {
         this.commentDraft = text;
         this.onDone(createSelectionResponse(this.pendingSelections, text));
      }
   }

   private finishModeSwitch(): void {
      this.updateHelpText();
      this.invalidate();
      this.tui.requestRender();
   }

   private showSelectMode(): void {
      if (this.mode === "freeform" || this.mode === "comment") {
         this.saveEditorDraft();
      }

      this.mode = "select";
      this.pendingSelections = [];
      this.modeContainer.clear();

      if (this.allowMultiple) {
         this.modeContainer.addChild(this.ensureMultiSelectList());
      } else {
         this.modeContainer.addChild(this.ensureSingleSelectList());
      }

      this.finishModeSwitch();
   }

   private showFreeformMode(): void {
      if (this.mode === "comment") {
         this.saveEditorDraft();
      }

      this.mode = "freeform";
      this.modeContainer.clear();

      const editor = this.ensureEditor();
      this.setEditorText(this.freeformDraft);
      (editor as any).focused = this._focused;

      this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold("Custom response")), 1, 0));
      this.modeContainer.addChild(new Spacer(1));
      this.modeContainer.addChild(editor);

      this.finishModeSwitch();
   }

   private showCommentMode(): void {
      if (this.mode === "freeform") {
         this.saveEditorDraft();
      }

      this.mode = "comment";
      this.modeContainer.clear();

      const editor = this.ensureEditor();
      this.setEditorText(this.commentDraft);
      (editor as any).focused = this._focused;

      const selectedLabel = this.pendingSelections.length === 1 ? "Selected option:" : "Selected options:";
      this.modeContainer.addChild(new Text(this.theme.fg("accent", this.theme.bold(selectedLabel)), 1, 0));
      this.modeContainer.addChild(new Text(this.theme.fg("text", this.pendingSelections.join(", ")), 1, 0));
      this.modeContainer.addChild(new Spacer(1));
      this.modeContainer.addChild(editor);

      this.finishModeSwitch();
   }

   private handleEditorModeInput(data: string): void {
      if (matchesKey(data, Key.escape)) return this.showSelectMode();
      if (this.keybindings.matches(data, "tui.select.cancel")) return this.onDone(null);
      this.ensureEditor().handleInput(data);
   }

   private handleSelectModeInput(data: string): void {
      const list = this.allowMultiple ? this.ensureMultiSelectList() : this.ensureSingleSelectList();
      list.handleInput?.(data);
   }

   handleInput(data: string): void {
      if (this.mode === "freeform" || this.mode === "comment") {
         this.handleEditorModeInput(data);
      } else {
         this.handleSelectModeInput(data);
      }
      this.tui.requestRender();
   }
}

/**
 * RPC/headless fallback: use dialog methods (select/input) instead of the rich TUI overlay.
 * ctx.ui.custom() returns undefined in RPC mode, so we degrade gracefully.
 */
function dialogOptions(timeout?: number): { timeout: number } | undefined {
   return timeout ? { timeout } : undefined;
}

function dialogPrompt(question: string, context: string | undefined): string {
   return context ? `${question}\n\nContext:\n${context}` : question;
}

async function askMultiViaDialogs(
   ui: { input: Function },
   prompt: string,
   options: QuestionOption[],
   allowComment: boolean,
   timeout?: number,
): Promise<AskUIResult | null> {
   const rawSelections = await ui.input(
      `${prompt}\n\nOptions (select one or more):\n${formatOptionsForMessage(options)}`,
      "Type your selection(s)...",
      dialogOptions(timeout),
   ) as string | undefined;
   if (isCancelledInput(rawSelections)) return null;

   const selections = parseDialogSelections(rawSelections);
   if (selections.length === 0) return null;
   if (!allowComment) return createSelectionResponse(selections);

   const comment = await ui.input(
      buildCommentPrompt(prompt, selections),
      "Optional comment (press Enter to skip)...",
      dialogOptions(timeout),
   ) as string | undefined;
   return createSelectionResponse(selections, comment);
}

async function askSingleViaDialogs(
   ui: { select: Function; input: Function },
   prompt: string,
   options: QuestionOption[],
   allowFreeform: boolean,
   allowComment: boolean,
   timeout?: number,
): Promise<AskUIResult | null> {
   const selectOptions = options.map((o) => o.title);
   if (allowFreeform) selectOptions.push(FREEFORM_SENTINEL);

   const selected = await ui.select(prompt, selectOptions, dialogOptions(timeout)) as string | undefined;
   if (isCancelledInput(selected)) return null;

   if (selected === FREEFORM_SENTINEL) {
      const answer = await ui.input(prompt, "Type your answer...", dialogOptions(timeout)) as string | undefined;
      return isCancelledInput(answer) ? null : createFreeformResponse(answer);
   }

   if (!allowComment) return createSelectionResponse([selected]);

   const comment = await ui.input(
      buildCommentPrompt(prompt, [selected]),
      "Optional comment (press Enter to skip)...",
      dialogOptions(timeout),
   ) as string | undefined;
   return createSelectionResponse([selected], comment);
}

async function askViaDialogs(
   ui: { select: Function; input: Function },
   question: string,
   context: string | undefined,
   options: QuestionOption[],
   allowMultiple: boolean,
   allowFreeform: boolean,
   allowComment: boolean,
   timeout?: number,
): Promise<AskUIResult | null> {
   const prompt = dialogPrompt(question, context);
   return allowMultiple
      ? askMultiViaDialogs(ui, prompt, options, allowComment, timeout)
      : askSingleViaDialogs(ui, prompt, options, allowFreeform, allowComment, timeout);
}

function renderWaitingResult(result: any, theme: Theme): Text {
   const waitingText = result.content
      ?.filter((part: { type?: string; text?: string }) => part?.type === "text")
      .map((part: { text?: string }) => part.text ?? "")
      .join("\n")
      .trim() || "Waiting for user input...";
   return new Text(theme.fg("muted", waitingText), 0, 0);
}

function appendExpandedResultDetails(text: string, details: AskToolDetails, response: AskResponse, theme: Theme): string {
   let output = `${text}\n${theme.fg("dim", `Q: ${details.question}`)}`;
   if (details.context) output += `\n${theme.fg("dim", details.context)}`;
   if (isSelectionResponse(response) && details.options.length > 0) {
      output += renderExpandedSelectionDetails(details, response, theme);
   }
   return output;
}

function renderExpandedSelectionDetails(details: AskToolDetails, response: Extract<AskResponse, { kind: "selection" }>, theme: Theme): string {
   const selectedTitles = new Set(response.selections);
   const optionLines = details.options.map((opt) => {
      const desc = opt.description ? ` — ${opt.description}` : "";
      const marker = selectedTitles.has(opt.title) ? theme.fg("success", "●") : theme.fg("dim", "○");
      return `  ${marker} ${theme.fg("dim", opt.title)}${theme.fg("dim", desc)}`;
   });
   const comment = response.comment ? `\n${theme.fg("dim", "Comment:")} ${theme.fg("dim", response.comment)}` : "";
   return `\n${theme.fg("dim", "Options:")}\n${optionLines.join("\n")}${comment}`;
}

function renderAskResult(result: any, options: { isPartial?: boolean; expanded?: boolean }, theme: Theme): Text {
   const details = result.details as (AskToolDetails & { error?: string }) | undefined;
   if (details?.error) return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
   if (options.isPartial) return renderWaitingResult(result, theme);
   if (!details || details.cancelled || !details.response) return new Text(theme.fg("warning", "Cancelled"), 0, 0);

   const response = details.response;
   let text = theme.fg("success", "✓ ");
   if (response.kind === "freeform") text += theme.fg("muted", "(wrote) ");
   text += theme.fg("accent", formatResponseSummary(response));
   if (options.expanded) text = appendExpandedResultDetails(text, details, response, theme);
   return new Text(text, 0, 0);
}

function cancelledAskResult(question: string, context: string | undefined, options: QuestionOption[]) {
   return {
      content: [{ type: "text", text: "User cancelled the question" }],
      details: { question, context, options, response: null, cancelled: true } as AskToolDetails,
   };
}

function answeredAskResult(question: string, context: string | undefined, options: QuestionOption[], response: AskResponse) {
   return {
      content: [{ type: "text", text: `User answered: ${formatResponseSummary(response)}` }],
      details: { question, context, options, response, cancelled: false } as AskToolDetails,
   };
}

function noUiAskResult(args: {
   question: string;
   context: string | undefined;
   options: QuestionOption[];
   allowFreeform: boolean;
   allowComment: boolean;
}) {
   const { question, context, options, allowFreeform, allowComment } = args;
   const optionText = options.length > 0 ? `\n\nOptions:\n${formatOptionsForMessage(options)}` : "";
   const freeformHint = allowFreeform ? "\n\nYou can also answer freely." : "";
   const commentHint = allowComment ? "\n\nAfter choosing an option, you may add an optional comment." : "";
   const contextText = context ? `\n\nContext:\n${context}` : "";
   return {
      content: [{ type: "text", text: `Ask requires interactive mode. Please answer:\n\n${question}${contextText}${optionText}${freeformHint}${commentHint}` }],
      isError: true,
      details: { question, context, options, response: null, cancelled: true } as AskToolDetails,
   };
}

function resolveDisplayMode(displayMode: AskDisplayMode | undefined): AskDisplayMode {
   const envMode = process.env.PI_ASK_USER_DISPLAY_MODE;
   const envDisplayMode = envMode === "overlay" || envMode === "inline" ? envMode : undefined;
   return displayMode ?? envDisplayMode ?? "overlay";
}

function resolveAskShortcuts(overlayToggleKey: string | null | undefined, commentToggleKey: string | null | undefined): ResolvedAskShortcuts {
   return {
      overlayToggle: resolveShortcut(overlayToggleKey, process.env.PI_ASK_USER_OVERLAY_TOGGLE_KEY, DEFAULT_OVERLAY_TOGGLE_KEY),
      commentToggle: resolveShortcut(commentToggleKey, process.env.PI_ASK_USER_COMMENT_TOGGLE_KEY, DEFAULT_COMMENT_TOGGLE_KEY),
   };
}

function buildAskCustomFactory(args: {
   signal: AbortSignal | undefined;
   timeout: number | undefined;
   question: string;
   context: string | undefined;
   options: QuestionOption[];
   allowMultiple: boolean;
   allowFreeform: boolean;
   allowComment: boolean;
   displayMode: AskDisplayMode;
   shortcuts: ResolvedAskShortcuts;
}) {
   return (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (result: AskUIResult | null) => void) => {
      args.signal?.addEventListener("abort", () => done(null), { once: true });
      if (args.timeout && args.timeout > 0) setTimeout(() => done(null), args.timeout);
      return new AskComponent(
         args.question,
         args.context,
         args.options,
         args.allowMultiple,
         args.allowFreeform,
         args.allowComment,
         args.displayMode,
         tui,
         theme,
         keybindings,
         args.shortcuts,
         done,
      );
   };
}

async function askWithCustomOrDialogs(args: {
   ctx: any;
   signal: AbortSignal | undefined;
   question: string;
   context: string | undefined;
   options: QuestionOption[];
   allowMultiple: boolean;
   allowFreeform: boolean;
   allowComment: boolean;
   timeout: number | undefined;
   displayMode: AskDisplayMode;
   shortcuts: ResolvedAskShortcuts;
}): Promise<AskUIResult | null> {
   let overlayHandle: OverlayHandle | undefined;
   let hasAnnouncedHide = false;
   const overlayToggle = args.shortcuts.overlayToggle;
   const removeOverlayInputListener = args.displayMode === "overlay" && !overlayToggle.disabled && typeof args.ctx.ui.onTerminalInput === "function"
      ? args.ctx.ui.onTerminalInput((data: string) => {
         if (!overlayToggle.matches(data) || !overlayHandle) return undefined;
         const nextHidden = !overlayHandle.isHidden();
         overlayHandle.setHidden(nextHidden);
         if (nextHidden && !hasAnnouncedHide) {
            hasAnnouncedHide = true;
            args.ctx.ui.notify?.(`ask_user hidden — press ${overlayToggle.spec} to reopen`, "info");
         }
         return { consume: true };
      })
      : undefined;

   try {
      const customResult = await args.ctx.ui.custom<AskUIResult | null>(
         buildAskCustomFactory(args),
         buildCustomUIOptions(args.displayMode, (handle) => { overlayHandle = handle; }),
      );
      return customResult !== undefined
         ? customResult
         : askViaDialogs(args.ctx.ui, args.question, args.context, args.options, args.allowMultiple, args.allowFreeform, args.allowComment, args.timeout);
   } finally {
      removeOverlayInputListener?.();
   }
}


interface NormalizedAskToolArgs {
   question: string;
   context: string | undefined;
   options: QuestionOption[];
   allowMultiple: boolean;
   allowFreeform: boolean;
   allowComment: boolean;
   effectiveDisplayMode: AskDisplayMode;
   shortcuts: ResolvedAskShortcuts;
   timeout: number | undefined;
}

function normalizeAskToolArgs(params: AskParams): NormalizedAskToolArgs {
   const {
      question,
      context,
      options: rawOptions = [],
      allowMultiple = false,
      allowFreeform = true,
      allowComment = false,
      displayMode,
      overlayToggleKey,
      commentToggleKey,
      timeout,
   } = params;

   return {
      question,
      context: context?.trim() || undefined,
      options: normalizeOptions(rawOptions),
      allowMultiple,
      allowFreeform,
      allowComment,
      effectiveDisplayMode: resolveDisplayMode(displayMode),
      shortcuts: resolveAskShortcuts(overlayToggleKey, commentToggleKey),
      timeout,
   };
}

function emitAskAnswered(pi: ExtensionAPI, question: string, context: string | undefined, response: AskResponse) {
   pi.events.emit("ask:answered", { question, context, response });
}

function emitAskCancelled(pi: ExtensionAPI, question: string, context: string | undefined, options: QuestionOption[]) {
   pi.events.emit("ask:cancelled", { question, context, options });
}

async function askFreeformOnly(pi: ExtensionAPI, ctx: any, args: NormalizedAskToolArgs) {
   const answer = await ctx.ui.input(dialogPrompt(args.question, args.context), "Type your answer...", dialogOptions(args.timeout));
   const response = createFreeformResponse(answer);
   if (!response) return cancelledAskResult(args.question, args.context, args.options);

   emitAskAnswered(pi, args.question, args.context, response);
   return answeredAskResult(args.question, args.context, args.options, response);
}

async function askWithOptions(pi: ExtensionAPI, args: NormalizedAskToolArgs, signal: AbortSignal | undefined, onUpdate: Function | undefined, ctx: any) {
   onUpdate?.({ content: [{ type: "text", text: "Waiting for user input..." }], details: { question: args.question, context: args.context, options: args.options, response: null, cancelled: false } });

   const result = await askWithCustomOrDialogs({
      ctx,
      signal,
      question: args.question,
      context: args.context,
      options: args.options,
      allowMultiple: args.allowMultiple,
      allowFreeform: args.allowFreeform,
      allowComment: args.allowComment,
      timeout: args.timeout,
      displayMode: args.effectiveDisplayMode,
      shortcuts: args.shortcuts,
   });

   if (result === null) {
      emitAskCancelled(pi, args.question, args.context, args.options);
      return cancelledAskResult(args.question, args.context, args.options);
   }

   emitAskAnswered(pi, args.question, args.context, result);
   return answeredAskResult(args.question, args.context, args.options, result);
}

async function executeAskTool(pi: ExtensionAPI, params: unknown, signal: AbortSignal | undefined, onUpdate: Function | undefined, ctx: any) {
   const parsed = params as AskParams;
   if (signal?.aborted) return cancelledSignalAskResult(parsed);

   const args = normalizeAskToolArgs(parsed);
   if (!hasAskUi(ctx)) return noUiAskResultFromArgs(args);

   return runAskToolWithUi(pi, ctx, args, signal, onUpdate);
}

function hasAskUi(ctx: any): boolean {
   return Boolean(ctx.hasUI && ctx.ui);
}

function cancelledSignalAskResult(params: AskParams) {
   return { content: [{ type: "text", text: "Cancelled" }], details: { question: params.question, options: [], response: null, cancelled: true } as AskToolDetails };
}

function noUiAskResultFromArgs(args: NormalizedAskToolArgs) {
   const { question, context, options, allowFreeform, allowComment } = args;
   return noUiAskResult({ question, context, options, allowFreeform, allowComment });
}

async function runAskToolWithUi(pi: ExtensionAPI, ctx: any, args: NormalizedAskToolArgs, signal: AbortSignal | undefined, onUpdate: Function | undefined) {
   try {
      if (args.options.length === 0) return await askFreeformOnly(pi, ctx, args);
      return await askWithOptions(pi, args, signal, onUpdate, ctx);
   } catch (error) {
      return failedAskResult(error);
   }
}

function failedAskResult(error: unknown) {
   const message = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
   return { content: [{ type: "text", text: `Ask tool failed: ${message}` }], isError: true, details: { error: message } };
}

export default function(pi: ExtensionAPI) {
   pi.registerTool({
      name: "ask_user",
      label: "Ask User",
      description:
         "Ask the user a question with optional multiple-choice answers. Use this to gather information interactively. Ask exactly one focused question per call. Before calling, gather context with tools (read/web/ref) and pass a short summary via the context field.",
      promptSnippet:
         "Ask the user one focused question with optional multiple-choice answers to gather information interactively",
      promptGuidelines: [
         "Before calling ask_user, gather context with tools (read/web/ref) and pass a short summary via the context field.",
         "Use ask_user when the user's intent is ambiguous, when a decision requires explicit user input, or when multiple valid options exist.",
         "Ask exactly one focused question per ask_user call.",
         "Do not combine multiple numbered, multipart, or unrelated questions into one ask_user prompt.",
      ],
      parameters: Type.Object({
         question: Type.String({ description: "The question to ask the user" }),
         context: Type.Optional(
            Type.String({
               description: "Relevant context to show before the question (summary of findings)",
            }),
         ),
         options: Type.Optional(
            Type.Array(
               Type.Union([
                  Type.String({ description: "Short title for this option" }),
                  Type.Object({
                     title: Type.String({ description: "Short title for this option" }),
                     description: Type.Optional(
                        Type.String({ description: "Longer description explaining this option" }),
                     ),
                  }),
               ]),
               { description: "List of options for the user to choose from" },
            ),
         ),
         allowMultiple: Type.Optional(
            Type.Boolean({ description: "Allow selecting multiple options. Default: false" }),
         ),
         allowFreeform: Type.Optional(
            Type.Boolean({ description: "Add a freeform text option. Default: true" }),
         ),
         allowComment: Type.Optional(
            Type.Boolean({ description: "Collect an optional comment after selecting one or more options. Default: false" }),
         ),
         displayMode: Type.Optional(
            StringEnum(["overlay", "inline"] as const, {
               description: "UI rendering mode. 'overlay' shows a centered modal, 'inline' renders in-place. Default: PI_ASK_USER_DISPLAY_MODE env var if set, otherwise 'overlay'. Omit to respect the user's configured preference.",
            }),
         ),
         overlayToggleKey: Type.Optional(
            Type.String({
               description:
                  "Shortcut for hiding/showing the overlay popup (overlay mode only), e.g. 'alt+o' or 'ctrl+shift+h'. Pass 'off' to disable. Default: PI_ASK_USER_OVERLAY_TOGGLE_KEY env var if set, otherwise 'alt+o'.",
            }),
         ),
         commentToggleKey: Type.Optional(
            Type.String({
               description:
                  "Shortcut for toggling the optional comment/extra-context row when allowComment is true, e.g. 'ctrl+g'. Pass 'off' to disable. Default: PI_ASK_USER_COMMENT_TOGGLE_KEY env var if set, otherwise 'ctrl+g'.",
            }),
         ),
         timeout: Type.Optional(
            Type.Number({ description: "Auto-dismiss after N milliseconds. Returns null (cancelled) when expired." }),
         ),
      }),

      async execute(_toolCallId, params, signal, onUpdate, ctx) {
         return executeAskTool(pi, params, signal, onUpdate, ctx);
      },

      renderCall(args, theme) {
         const question = (args.question as string) || "";
         const rawOptions = Array.isArray(args.options) ? args.options : [];
         let text = theme.fg("toolTitle", theme.bold("ask_user "));
         text += theme.fg("muted", question);
         if (rawOptions.length > 0) {
            const labels = rawOptions.map((o: unknown) =>
               typeof o === "string" ? o : (o as QuestionOption)?.title ?? "",
            );
            text += "\n" + theme.fg("dim", `  ${rawOptions.length} option(s): ${labels.join(", ")}`);
         }
         if (args.allowMultiple) {
            text += theme.fg("dim", " [multi-select]");
         }
         if (args.allowComment) {
            text += theme.fg("dim", " [optional comment]");
         }
         return new Text(text, 0, 0);
      },

      renderResult(result, options, theme) {
         return renderAskResult(result, options, theme);
      },
   });
}
