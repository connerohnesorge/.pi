/**
 * "Workflows mode" input affordance, à la a smart input box:
 *
 *  - While the editor text contains the word `workflow`/`workflows`, those letters
 *    render as a flowing rainbow, signalling that submitting will engage a workflow.
 *  - Pressing Backspace immediately after such a word toggles the highlight OFF
 *    (the word stays, but turns plain white) — a non-destructive "don't run a
 *    workflow after all". Re-typing a fresh trigger word turns it back on.
 *  - When the highlight is ON at submit time, the user's message is transformed to
 *    instruct Pi to actually run the workflow tool.
 *
 * Implementation: we replace the core editor with a thin subclass of the exported
 * `CustomEditor` (which itself extends pi-tui's `Editor`), overriding only
 * `render()` (to colorize) and `handleInput()` (for the Backspace toggle). All
 * other editor behavior — history, autocomplete, paste, undo, multiline — is
 * inherited untouched.
 */

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { DEFAULT_KEYWORD_TRIGGER_WORD, normalizeKeywordTriggerWord } from "./config.ts";
import { type EffortState, effortDirective, isSubstantive } from "./effort-command.ts";
import {
  loadWorkflowSettings,
  saveWorkflowSettings,
  type WorkflowSettings,
  type WorkflowSettingsStore,
} from "./workflow-settings.ts";

// A keyword trigger is a configured literal term. The default `workflow`
// trigger keeps legacy substring behavior and plural support (`workflows`) while
// custom trigger words match only that exact term. Slash commands like
// `/workflows` or `/pi-workflow` are left alone (not colored, not armed).
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function triggerSource(triggerWord: string): string {
  const escaped = escapeRegExp(triggerWord);
  if (triggerWord.toLowerCase() === DEFAULT_KEYWORD_TRIGGER_WORD) return `(?<!\\/)${escaped}s?`;
  return `(?<![/A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`;
}

function triggerRegex(triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD, flags = "i", atEnd = false): RegExp {
  const word = normalizeKeywordTriggerWord(triggerWord) ?? DEFAULT_KEYWORD_TRIGGER_WORD;
  return new RegExp(`${triggerSource(word)}${atEnd ? "$" : ""}`, flags);
}

/** 256-color ring cycling through the spectrum — shifted by a tick to "flow". */
export const RAINBOW = [
  196, 160, 202, 166, 208, 172, 214, 178, 220, 184, 226, 190, 118, 82, 46, 47, 48, 49, 50, 51, 45, 39, 33, 27, 21, 57,
  93, 129, 165, 201, 198, 197,
];

export function hasTrigger(text: string, triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD): boolean {
  return triggerRegex(triggerWord).test(text);
}

export function endsWithTrigger(textBeforeCursor: string, triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD): boolean {
  return triggerRegex(triggerWord, "i", true).test(textBeforeCursor);
}

/** Shared, mutable view of whether "workflows mode" is currently armed. */
export interface WorkflowModeState {
  active: boolean;
  keywordTriggerEnabled: boolean;
  keywordTriggerWord?: string;
  suppressedKeywordText?: string;
}

export interface InstallWorkflowEditorOptions {
  settingsStore?: WorkflowSettingsStore;
}

interface AnsiToken {
  esc?: string;
  ch?: string;
}

/**
 * Split a rendered line into ANSI-escape tokens (passed through verbatim) and
 * single visible-character tokens. Handles CSI sequences (`\x1b[…m`, e.g. the
 * cursor's inverse-video) and APC/OSC string sequences (e.g. the zero-width
 * `CURSOR_MARKER` = `\x1b_pi:c\x07`) so colorization never corrupts them.
 */
export function tokenizeAnsi(line: string): AnsiToken[] {
  const tokens: AnsiToken[] = [];
  for (let i = 0; i < line.length; ) {
    if (line[i] === "\x1b") {
      const end = ansiEscapeEnd(line, i);
      tokens.push({ esc: line.slice(i, end) });
      i = end;
    } else {
      tokens.push({ ch: line[i++] });
    }
  }
  return tokens;
}

function ansiEscapeEnd(line: string, start: number): number {
  let j = start + 1;
  const next = line[j];
  if (next === "[") return csiEnd(line, j + 1);
  if (next === "]" || next === "_" || next === "P" || next === "^") return stringEscapeEnd(line, j + 1);
  return j + 1; // lone ESC + one byte
}

function csiEnd(line: string, i: number): number {
  while (i < line.length && !(line[i] >= "@" && line[i] <= "~")) i++;
  return i + 1;
}

function stringEscapeEnd(line: string, i: number): number {
  while (i < line.length && line[i] !== "\x07" && !(line[i] === "\x1b" && line[i + 1] === "\\")) i++;
  if (line[i] === "\x07") return i + 1;
  if (line[i] === "\x1b") return i + 2;
  return i;
}

/**
 * Colorize every `workflow`/`workflows` occurrence in a rendered line with a
 * flowing rainbow, leaving all ANSI escapes (cursor, markers) intact. Returns the
 * line unchanged when it contains no trigger.
 */
export function colorizeWorkflow(
  line: string,
  tick: number,
  palette: number[] = RAINBOW,
  triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD,
): string {
  const tokens = tokenizeAnsi(line);
  const visible = visibleText(tokens);
  if (!hasTrigger(visible, triggerWord)) return line;
  return colorizeTokens(tokens, triggerRanges(visible, triggerWord), tick, palette);
}

function visibleText(tokens: AnsiToken[]): string {
  return tokens
    .filter((t) => t.ch !== undefined)
    .map((t) => t.ch)
    .join("");
}

function triggerRanges(visible: string, triggerWord: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const globalTrigger = triggerRegex(triggerWord, "gi");
  for (let m = globalTrigger.exec(visible); m; m = globalTrigger.exec(visible)) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function inRanges(idx: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => idx >= s && idx < e);
}

function colorizeTokens(tokens: AnsiToken[], ranges: Array<[number, number]>, tick: number, palette: number[]): string {
  let out = "";
  let vi = 0;
  for (const t of tokens) {
    if (t.esc !== undefined) {
      out += t.esc;
    } else {
      out += inRanges(vi, ranges) ? colorChar(t.ch ?? "", vi, tick, palette) : t.ch ?? "";
      vi++;
    }
  }
  return out;
}

function colorChar(ch: string, vi: number, tick: number, palette: number[]): string {
  const color = palette[(vi + tick) % palette.length];
  // Reset only the foreground (39) afterwards so a surrounding inverse-video
  // (the cursor) is preserved.
  return `\x1b[38;5;${color}m${ch}\x1b[39m`;
}

/** Backspace arrives as DEL (0x7f) or BS (0x08) depending on the terminal. */
function isBackspace(data: string): boolean {
  return data === "\x7f" || data === "\b";
}

/**
 * Editor that paints the trigger words and owns the on/off toggle. Reads/writes
 * `state.active` so the extension's `input` handler can decide whether to force a
 * workflow at submit time.
 */
export class WorkflowEditor extends CustomEditor {
  private tick = 0;
  private timer?: ReturnType<typeof setInterval>;
  /** Toggled off by Backspace-after-word; re-armed when a fresh trigger appears. */
  private disabled = false;
  private wasTriggered = false;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    private readonly modeState: WorkflowModeState,
  ) {
    super(tui, theme, keybindings);
  }

  /** Highlighted/armed: a trigger is present and the user hasn't toggled it off. */
  isActive(): boolean {
    return (
      this.modeState.keywordTriggerEnabled &&
      !this.disabled &&
      hasTrigger(this.getText(), this.modeState.keywordTriggerWord)
    );
  }

  override handleInput(data: string): void {
    // First Backspace right after a trigger word disarms (non-destructive).
    if (isBackspace(data) && this.isActive() && this.cursorAfterTrigger()) {
      this.disableTriggerForCurrentText();
      return;
    }
    const before = this.getText();
    super.handleInput(data);
    this.updateTriggerAfterEdit(before);
    this.syncState();
  }

  private disableTriggerForCurrentText(): void {
    this.disabled = true;
    this.modeState.suppressedKeywordText = this.getText().trim();
    this.syncState();
    this.tui.requestRender();
  }

  private updateTriggerAfterEdit(before: string): void {
    const after = this.getText();
    if (after === before) return;
    const now = hasTrigger(after, this.modeState.keywordTriggerWord);
    const suppressionCleared = this.clearSuppressionIfTextChanged(after.trim());
    // A freshly typed trigger re-arms a previously disabled box.
    if (now && (!this.wasTriggered || suppressionCleared)) this.disabled = false;
    this.wasTriggered = now;
  }

  private clearSuppressionIfTextChanged(normalizedAfter: string): boolean {
    const suppressionCleared =
      this.modeState.suppressedKeywordText !== undefined &&
      normalizedAfter !== "" &&
      normalizedAfter !== this.modeState.suppressedKeywordText;
    if (suppressionCleared) this.modeState.suppressedKeywordText = undefined;
    return suppressionCleared;
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    // Keep the shared state current even for non-keystroke changes (history
    // recall, programmatic setText) so the submit hook reads the right value.
    this.syncState();
    this.reconcileAnimation();
    if (!this.isActive() || lines.length === 0) return lines;
    // First and last lines are the editor's horizontal borders; only the text
    // lines in between are colorized.
    return lines.map((ln, i) =>
      i === 0 || i === lines.length - 1
        ? ln
        : colorizeWorkflow(ln, this.tick, RAINBOW, this.modeState.keywordTriggerWord),
    );
  }

  /** Absolute text before the cursor, used to detect "right after the word". */
  private cursorAfterTrigger(): boolean {
    const lines = this.getLines();
    const { line, col } = this.getCursor();
    const before = lines.slice(0, line).join("\n") + (line > 0 ? "\n" : "") + (lines[line] ?? "").slice(0, col);
    return endsWithTrigger(before, this.modeState.keywordTriggerWord);
  }

  private syncState(): void {
    this.modeState.active = this.isActive();
  }

  private reconcileAnimation(): void {
    const shouldRun = this.isActive() && this.focused;
    if (shouldRun && !this.timer) {
      this.timer = setInterval(() => {
        this.tick = (this.tick + 1) % (RAINBOW.length * 6);
        this.tui.requestRender();
      }, 90);
      // Don't keep the process alive for the animation.
      (this.timer as { unref?: () => void }).unref?.();
    } else if (!shouldRun && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * The directive appended to a submitted message when workflows mode is armed.
 * `extraDirective` (e.g. an effort-tier nudge) is appended when present.
 */
export function buildForcedWorkflowPrompt(text: string, extraDirective?: string): string {
  const lines = [
    text,
    "",
    "---",
    "[workflows mode is ON for this message]",
    "You MUST handle this request by calling the tool named exactly `workflow` (Pi's",
    "deterministic JavaScript workflow-orchestration tool).",
    "Write a workflow script that fans the task out across subagents via",
    "agent()/parallel()/pipeline(). Give each agent() a unique short label and",
    "an opts.tier ('small', 'medium', or 'big').",
    "",
    "The ONLY acceptable action is a `workflow` tool call. Do NOT instead:",
    "- answer directly or in prose,",
    "- hand-roll subagent orchestration outside the `workflow` tool,",
    "- use any skill or command instead (e.g. /code-review, /deep-research),",
    '- or interpret the word "workflow/workflows" loosely as some other parallel/audit approach.',
    "Even for a small task, wrap it in a minimal `workflow` call with at least one agent().",
  ];
  if (extraDirective) lines.push("", extraDirective);
  return lines.join("\n");
}

/**
 * Install the workflows-mode editor and the submit-time forcing hook.
 * Call once with the UI context (e.g. in `session_start`).
 */
/** The exact name of the workflow tool that workflows mode forces. */
export const WORKFLOW_TOOL_NAME = "workflow";

export function registerWorkflowTriggerCommand(
  pi: ExtensionAPI,
  state: WorkflowModeState,
  settingsStore: WorkflowSettingsStore = DEFAULT_SETTINGS_STORE,
): void {
  pi.registerCommand?.("workflows-trigger", {
    description: "Keyword workflow trigger: on | off | set <word> | reset | status",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      await handleWorkflowTriggerCommand(args, pi, state, settingsStore);
    },
  });
}

type TriggerSay = (content: string) => Promise<unknown>;

async function handleWorkflowTriggerCommand(
  args: string,
  pi: ExtensionAPI,
  state: WorkflowModeState,
  settingsStore: WorkflowSettingsStore,
): Promise<void> {
  const [command = "status", ...rest] = args.trim().split(/\s+/);
  const say: TriggerSay = (content) => pi.sendMessage({ customType: "workflows-trigger", content, display: true });
  if (command.toLowerCase() === "on") return setWorkflowTriggerEnabled(true, state, settingsStore, say);
  if (command.toLowerCase() === "off") return setWorkflowTriggerEnabled(false, state, settingsStore, say);
  if (command.toLowerCase() === "set") return setWorkflowTriggerWord(rest.join(" "), state, settingsStore, say);
  if (command.toLowerCase() === "reset") return resetWorkflowTriggerWord(state, settingsStore, say);
  return reportWorkflowTriggerStatus(state, say);
}

async function setWorkflowTriggerEnabled(
  enabled: boolean,
  state: WorkflowModeState,
  settingsStore: WorkflowSettingsStore,
  say: TriggerSay,
): Promise<void> {
  state.keywordTriggerEnabled = enabled;
  state.active = enabled ? state.active : false;
  state.suppressedKeywordText = undefined;
  const saved = persistWorkflowTriggerSettings(settingsStore, { keywordTriggerEnabled: enabled });
  await say(workflowTriggerEnabledMessage(enabled, saved, state.keywordTriggerWord));
}

function workflowTriggerEnabledMessage(enabled: boolean, saved: boolean, keywordTriggerWord: string | undefined): string {
  if (enabled) {
    return saved
      ? `Workflows keyword trigger on — mentioning ${triggerDisplayName(keywordTriggerWord)} in an interactive message will auto-arm workflows mode. Saved for new sessions.`
      : "Workflows keyword trigger on for this session, but the preference could not be saved.";
  }
  return saved
    ? `Workflows keyword trigger off — messages can mention ${triggerDisplayName(keywordTriggerWord)} without forcing the workflow tool. Saved for new sessions. Use /workflows-trigger on to restore.`
    : "Workflows keyword trigger off for this session, but the preference could not be saved. Use /workflows-trigger on to restore.";
}

async function setWorkflowTriggerWord(
  requested: string,
  state: WorkflowModeState,
  settingsStore: WorkflowSettingsStore,
  say: TriggerSay,
): Promise<void> {
  const keywordTriggerWord = normalizeKeywordTriggerWord(requested);
  if (!keywordTriggerWord) {
    await say('Invalid trigger word. Use a non-empty term with no spaces and no leading "/", e.g. /workflows-trigger set pi-workflow');
    return;
  }
  state.keywordTriggerWord = keywordTriggerWord;
  state.suppressedKeywordText = undefined;
  const saved = persistWorkflowTriggerSettings(settingsStore, { keywordTriggerWord });
  await say(
    saved
      ? `Workflows keyword trigger word set to "${keywordTriggerWord}". Saved for new sessions.`
      : `Workflows keyword trigger word set to "${keywordTriggerWord}" for this session, but the preference could not be saved.`,
  );
}

async function resetWorkflowTriggerWord(
  state: WorkflowModeState,
  settingsStore: WorkflowSettingsStore,
  say: TriggerSay,
): Promise<void> {
  state.keywordTriggerWord = DEFAULT_KEYWORD_TRIGGER_WORD;
  state.suppressedKeywordText = undefined;
  const saved = persistWorkflowTriggerSettings(settingsStore, { keywordTriggerWord: DEFAULT_KEYWORD_TRIGGER_WORD });
  await say(
    saved
      ? 'Workflows keyword trigger word reset to "workflow" (also matches "workflows"). Saved for new sessions.'
      : 'Workflows keyword trigger word reset to "workflow" for this session, but the preference could not be saved.',
  );
}

async function reportWorkflowTriggerStatus(state: WorkflowModeState, say: TriggerSay): Promise<void> {
  const keywordTriggerWord = resolvedTriggerWord(state.keywordTriggerWord);
  await say(
    `Workflows keyword trigger is ${state.keywordTriggerEnabled ? "on" : "off"}; trigger word is "${keywordTriggerWord}". Changes are saved for new sessions. Usage: /workflows-trigger on | off | set <word> | reset | status`,
  );
}

/**
 * Register the bottom progress-panel preference commands:
 *  - `/workflows-progress compact|detailed|status` — switch (or report) the panel mode.
 *  - `/workflows-progress-max <1-1000>` — cap agents shown per phase in detailed mode.
 * Both persist via `settingsStore` and take effect on the next live run (the panel
 * live-reads its settings), so no session restart is needed.
 */
export function registerWorkflowProgressCommands(
  pi: ExtensionAPI,
  settingsStore: WorkflowSettingsStore = DEFAULT_SETTINGS_STORE,
): void {
  pi.registerCommand?.("workflows-progress", {
    description: "Bottom progress panel: compact | detailed | status",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const arg = args.trim().toLowerCase();
      const say = (content: string) => pi.sendMessage({ customType: "workflows-progress", content, display: true });
      if (arg === "compact" || arg === "detailed") {
        const saved = persistProgressSettings(settingsStore, { progressPanelMode: arg });
        await say(
          saved
            ? `Workflow progress panel set to ${arg} — takes effect on the next render of a live run (no restart needed).`
            : `Workflow progress panel set to ${arg} for this session, but the preference could not be saved.`,
        );
        return;
      }
      await say(
        `Workflow progress panel is ${loadProgressMode(settingsStore)}. Usage: /workflows-progress compact | detailed | status`,
      );
    },
  });

  pi.registerCommand?.("workflows-progress-max", {
    description: "Max agents shown per phase in detailed progress mode (1-1000)",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const arg = args.trim();
      const say = (content: string) => pi.sendMessage({ customType: "workflows-progress", content, display: true });
      if (!arg) {
        await say(
          `Detailed progress shows up to ${loadProgressMaxAgents(settingsStore)} agents per phase. Usage: /workflows-progress-max <1-1000>`,
        );
        return;
      }
      const n = Number.parseInt(arg, 10);
      if (!Number.isFinite(n) || n < 1) {
        await say(`Invalid value "${arg}". Usage: /workflows-progress-max <1-1000> (a whole number ≥ 1).`);
        return;
      }
      const clamped = Math.min(1000, n);
      const saved = persistProgressSettings(settingsStore, { progressPanelMaxAgents: clamped });
      await say(
        saved
          ? `Detailed progress now shows up to ${clamped} agents per phase.`
          : `Set to ${clamped} for this session, but the preference could not be saved.`,
      );
    },
  });
}

export function installWorkflowEditor(
  pi: ExtensionAPI,
  ui: ExtensionUIContext,
  effort?: EffortState,
  options: InstallWorkflowEditorOptions = {},
): WorkflowModeState {
  const settingsStore = options.settingsStore ?? DEFAULT_SETTINGS_STORE;
  const initialSettings = loadInitialWorkflowSettings(settingsStore);
  const state: WorkflowModeState = {
    active: false,
    keywordTriggerEnabled: initialSettings.keywordTriggerEnabled ?? true,
    keywordTriggerWord: initialSettings.keywordTriggerWord ?? DEFAULT_KEYWORD_TRIGGER_WORD,
  };

  if (!ui.getEditorComponent?.()) {
    ui.setEditorComponent((tui, theme, keybindings) => new WorkflowEditor(tui, theme, keybindings, state));
  }
  registerWorkflowTriggerCommand(pi, state, settingsStore);
  registerWorkflowProgressCommands(pi, settingsStore);

  // Active tools saved while a turn is restricted to `workflow`; restored on turn_end.
  let savedTools: string[] | undefined;

  // When armed at submit time, rewrite the user's message to force a workflow AND
  // ensure the `workflow` tool is in the active tool set, so the model can call it.
  // We keep all existing tools (bash, read, edit, write, web_search, etc.) because
  // the model often needs them BEFORE writing the workflow script (e.g. exploring
  // the codebase, reading files, searching for context). This only ADDS the
  // workflow tool to the active set; no tools are removed (the original set is
  // saved in `savedTools` and restored elsewhere).
  //
  // NOTE: we check event.text directly (hasTrigger) rather than state.active from
  // the editor, because the editor's state is reset synchronously by submitValue()
  // BEFORE the input event fires (the actual prompt processing is async).
  pi.on("input", (event: { source?: string; text?: string }) => {
    const decision = workflowInputDecision(event, state, effort);
    if (!decision.force || !event.text) return { action: "continue" } as const;
    savedTools = ensureWorkflowToolActive(pi, savedTools);
    return { action: "transform", text: buildForcedWorkflowPrompt(event.text, decision.extraDirective) } as const;
  });

  // Restore the user's full tool set once the forced turn completes.
  pi.on("turn_end", () => {
    if (savedTools === undefined) return;
    const restore = savedTools;
    savedTools = undefined;
    try {
      pi.setActiveTools?.(restore);
    } catch {
      // ignore — nothing we can do if the host rejects the restore
    }
  });

  return state;
}

const DEFAULT_SETTINGS_STORE: WorkflowSettingsStore = {
  load: loadWorkflowSettings,
  save: saveWorkflowSettings,
};

function loadInitialWorkflowSettings(settingsStore: WorkflowSettingsStore): WorkflowSettings {
  try {
    const settings = settingsStore.load();
    return {
      keywordTriggerEnabled: settings.keywordTriggerEnabled,
      keywordTriggerWord: normalizeKeywordTriggerWord(settings.keywordTriggerWord) ?? DEFAULT_KEYWORD_TRIGGER_WORD,
    };
  } catch {
    return { keywordTriggerEnabled: true, keywordTriggerWord: DEFAULT_KEYWORD_TRIGGER_WORD };
  }
}

function persistWorkflowTriggerSettings(settingsStore: WorkflowSettingsStore, settings: WorkflowSettings): boolean {
  try {
    settingsStore.save(settings);
    return true;
  } catch {
    return false;
  }
}

function resolvedTriggerWord(keywordTriggerWord: string | undefined): string {
  return normalizeKeywordTriggerWord(keywordTriggerWord) ?? DEFAULT_KEYWORD_TRIGGER_WORD;
}

function triggerDisplayName(keywordTriggerWord: string | undefined): string {
  const word = resolvedTriggerWord(keywordTriggerWord);
  return word.toLowerCase() === DEFAULT_KEYWORD_TRIGGER_WORD ? "workflow/workflows" : `"${word}"`;
}

function workflowInputDecision(
  event: { source?: string; text?: string },
  state: WorkflowModeState,
  effort?: EffortState,
): { force: boolean; extraDirective?: string } {
  if (event.source !== "interactive" || !event.text) return { force: false };
  const triggered = keywordTriggerDecision(event.text, state);
  const byEffort = !triggered && effortTriggersWorkflow(event.text, effort);
  return { force: triggered || byEffort, extraDirective: byEffort && effort ? effortDirective(effort.level) : undefined };
}

function keywordTriggerDecision(text: string, state: WorkflowModeState): boolean {
  const suppressed = state.suppressedKeywordText === text.trim();
  if (suppressed) state.suppressedKeywordText = undefined;
  return state.keywordTriggerEnabled && !suppressed && hasTrigger(text, state.keywordTriggerWord);
}

function effortTriggersWorkflow(text: string, effort?: EffortState): boolean {
  return !!effort && effort.level !== "off" && isSubstantive(text);
}

function ensureWorkflowToolActive(pi: ExtensionAPI, savedTools: string[] | undefined): string[] | undefined {
  if (savedTools !== undefined) return savedTools;
  try {
    const restore = pi.getActiveTools?.() ?? [];
    const current = [...restore];
    if (!current.includes(WORKFLOW_TOOL_NAME)) current.push(WORKFLOW_TOOL_NAME);
    pi.setActiveTools?.(current);
    return restore;
  } catch {
    // Tool restriction is best-effort; the directive still forces the workflow.
    return savedTools;
  }
}

function persistProgressSettings(settingsStore: WorkflowSettingsStore, settings: WorkflowSettings): boolean {
  try {
    settingsStore.save(settings);
    return true;
  } catch {
    return false;
  }
}

function loadProgressMode(settingsStore: WorkflowSettingsStore): "compact" | "detailed" {
  try {
    return settingsStore.load().progressPanelMode ?? "compact";
  } catch {
    return "compact";
  }
}

function loadProgressMaxAgents(settingsStore: WorkflowSettingsStore): number {
  try {
    return settingsStore.load().progressPanelMaxAgents ?? 8;
  } catch {
    return 8;
  }
}
