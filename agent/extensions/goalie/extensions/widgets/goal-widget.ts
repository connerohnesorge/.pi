import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	displayObjectiveTitle,
	formatDuration,
	formatTokenValue,
	truncateText,
	type GoalDisplayRecordLike,
} from "../goal-core.ts";
import {
	currentToolElapsedSeconds,
	elapsedSecondsFromMs,
	type GoalAuditorProgress,
} from "../goal-auditor-progress.ts";


type GoalWidgetColor = Extract<ThemeColor, "accent" | "warning" | "success" | "error" | "dim" | "muted" | "text">;

export interface GoalWidgetRecord extends GoalDisplayRecordLike {
	activePath?: string | null;
	archivedPath?: string | null;
	pauseReason?: string;
	pauseSuggestedAction?: string;
}

export type AuditorWidgetProgress = GoalAuditorProgress;

export interface GoalWidgetOptions {
	theme: Theme;
	tui: TUI;
	getGoal: () => GoalWidgetRecord | null;
	getOpenGoalCount?: () => number;
	getAuditorProgress?: () => AuditorWidgetProgress | null;
}

function fit(value: string, width: number): string {
	return visibleWidth(value) > width ? truncateToWidth(value, width, "…") : value;
}

function heading(theme: Theme, width: number, left: string, right = ""): string {
	if (!right) return fit(left, width);
	const rightPart = ` ${right}`;
	const fill = Math.max(1, width - visibleWidth(left) - visibleWidth(rightPart));
	return fit(`${left}${theme.fg("dim", " ".repeat(fill))}${rightPart}`, width);
}

function branchLine(theme: Theme, width: number, isLast: boolean, content: string): string {
	const prefix = isLast ? "└─" : "├─";
	return fit(`${theme.fg("dim", prefix)} ${content}`, width);
}

function displayIcon(goal: GoalWidgetRecord): { icon: string; color: GoalWidgetColor; label: string } {
	if (goal.status === "complete") return { icon: "✓", color: "success", label: "complete" };
	if (goal.status === "paused") {
		return goal.stopReason === "agent"
			? { icon: "⊘", color: "warning", label: "blocked" }
			: { icon: "◐", color: "muted", label: "paused" };
	}
	if (goal.sisyphus) return { icon: "◆", color: "accent", label: goal.autoContinue ? "sisyphus running" : "sisyphus idle" };
	return goal.autoContinue ? { icon: "●", color: "accent", label: "goal running" } : { icon: "○", color: "muted", label: "goal idle" };
}

function headingMeta(goal: GoalWidgetRecord, otherOpenGoalCount = 0): string {
	const bits: string[] = [];
	if (goal.status === "active" && goal.autoContinue) bits.push("auto");
	if (goal.usage.activeSeconds > 0) bits.push(formatDuration(goal.usage.activeSeconds));
	if (goal.usage.tokensUsed > 0) bits.push(formatTokenValue(goal.usage.tokensUsed));
	if (otherOpenGoalCount > 0) bits.push(`+${otherOpenGoalCount} open`);
	return bits.join(" · ");
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function spinnerFrame(): string {
	return SPINNER[Math.floor(Date.now() / 80) % SPINNER.length]!;
}

function makeProgressBar(percent: number, width: number): string {
	const totalBlocks = Math.max(8, width);
	const filledBlocks = Math.round((percent / 100) * totalBlocks);
	const unfilledBlocks = Math.max(0, totalBlocks - filledBlocks);
	const bar = "█".repeat(filledBlocks) + "░".repeat(unfilledBlocks);
	return `[${bar}] ${percent}%`;
}

const AUDITOR_PHASE_STEPS: Record<string, { label: string; percent: number }> = {
	done: { label: "Audit complete!", percent: 100 },
	producing_report: { label: "Producing report...", percent: 90 },
};

const AUDITOR_TOOL_STEPS = new Map<string, { label: string; percent: number }>([
	["find", { label: "Inspecting files...", percent: 25 }],
	["ls", { label: "Inspecting files...", percent: 25 }],
	["grep", { label: "Verifying success criteria...", percent: 50 }],
	["read", { label: "Verifying success criteria...", percent: 50 }],
	["bash", { label: "Running verification tests...", percent: 75 }],
]);

const AUDITOR_ELAPSED_STEPS = [
	{ beforeMs: 3000, label: "Inspecting files...", percent: 15 },
	{ beforeMs: 8000, label: "Verifying success criteria...", percent: 40 },
	{ beforeMs: 14000, label: "Running verification tests...", percent: 65 },
] as const;

function getAuditorStepInfo(progress: AuditorWidgetProgress): { label: string; percent: number } {
	const phaseStep = AUDITOR_PHASE_STEPS[progress.phase];
	if (phaseStep) return phaseStep;
	if (progress.currentTool) return AUDITOR_TOOL_STEPS.get(progress.currentTool) ?? elapsedAuditorStep(progress.elapsedMs || 0);
	return elapsedAuditorStep(progress.elapsedMs || 0);
}

function elapsedAuditorStep(elapsedMs: number): { label: string; percent: number } {
	return AUDITOR_ELAPSED_STEPS.find((step) => elapsedMs < step.beforeMs) ?? { label: "Producing report...", percent: 85 };
}

function auditorHeading(progress: AuditorWidgetProgress, theme: Theme, safeWidth: number): string {
	const isActive = progress.phase !== "done";
	const icon = isActive ? theme.fg("accent", spinnerFrame()) : theme.fg("success", "✓");
	const label = isActive ? "auditing" : "audit complete";
	// formatDuration expects seconds, progress.elapsedMs is in milliseconds
	const duration = formatDuration(elapsedSecondsFromMs(progress.elapsedMs));
	return heading(theme, safeWidth, `${icon} ${theme.fg("accent", theme.bold("Goalie Audit"))} ${theme.fg("muted", label)}`, theme.fg("muted", duration));
}

function appendAuditorStep(lines: string[], progress: AuditorWidgetProgress, theme: Theme, safeWidth: number): void {
	const step = getAuditorStepInfo(progress);
	const barStr = makeProgressBar(step.percent, Math.min(16, Math.max(8, Math.floor(safeWidth / 4))));
	lines.push(branchLine(theme, safeWidth, false, `${theme.fg("accent", step.label)}  ${theme.fg("muted", barStr)}`));
}

function appendAuditorTool(lines: string[], progress: AuditorWidgetProgress, theme: Theme, safeWidth: number, now: number): void {
	if (progress.phase === "done" || !progress.currentTool) return;
	const argText = progress.currentToolArgs ? truncateText(progress.currentToolArgs, Math.max(10, safeWidth - 24)) : "";
	const toolElapsedSeconds = currentToolElapsedSeconds(progress, now);
	const toolDuration = toolElapsedSeconds !== null ? ` ${theme.fg("dim", formatDuration(toolElapsedSeconds))}` : "";
	lines.push(branchLine(theme, safeWidth, false, `${theme.fg("accent", "tool")} ${theme.fg("text", progress.currentTool)}${argText ? ` ${theme.fg("dim", argText)}` : ""}${toolDuration}`));
}

function appendAuditorOutput(lines: string[], progress: AuditorWidgetProgress, theme: Theme, safeWidth: number): void {
	if (progress.recentOutput.length === 0) return;
	const isActive = progress.phase !== "done";
	lines.push(branchLine(theme, safeWidth, !isActive, theme.fg("dim", "─".repeat(Math.max(4, safeWidth - 6)))));
	for (const [index, line] of progress.recentOutput.entries()) {
		const isLast = index === progress.recentOutput.length - 1 && !isActive;
		lines.push(branchLine(theme, safeWidth, isLast, theme.fg("dim", truncateText(line, Math.max(8, safeWidth - 6)))));
	}
}

function appendAuditorSkipHint(lines: string[], progress: AuditorWidgetProgress, theme: Theme, safeWidth: number): void {
	if (progress.phase === "done") return;
	lines.push(branchLine(theme, safeWidth, true, theme.fg("warning", "Esc to skip") + theme.fg("dim", " — abort the audit and mark the goal complete")));
}

export function renderAuditorWidgetLines(progress: AuditorWidgetProgress, theme: Theme, width: number, options: { now?: number } = {}): string[] {
	const safeWidth = Math.max(1, width);
	const lines: string[] = [auditorHeading(progress, theme, safeWidth)];
	appendAuditorStep(lines, progress, theme, safeWidth);
	appendAuditorTool(lines, progress, theme, safeWidth, options.now ?? Date.now());
	appendAuditorOutput(lines, progress, theme, safeWidth);
	appendAuditorSkipHint(lines, progress, theme, safeWidth);
	return lines;
}

function renderUnfocusedGoalLines(openGoalCount: number, theme: Theme, safeWidth: number): string[] {
	if (openGoalCount <= 0) return [];
	return [
		heading(theme, safeWidth, `${theme.fg("warning", "◇")} ${theme.fg("warning", theme.bold("Goal"))} ${theme.fg("muted", "unfocused")}`, theme.fg("muted", `${openGoalCount} open`)),
		branchLine(theme, safeWidth, true, `${theme.fg("muted", "Run /goalie-focus to choose this session's goalie")}`),
	];
}

function goalHeading(goal: GoalWidgetRecord, theme: Theme, openGoalCount: number, safeWidth: number): string {
	const { icon, color, label } = displayIcon(goal);
	const mode = goal.sisyphus ? "Sisyphus" : "Goal";
	const headingLeft = `${theme.fg(color, icon)} ${theme.fg(color, theme.bold(mode))} ${theme.fg("muted", label.replace(/^sisyphus |^goal /, ""))}`;
	const headingRight = theme.fg("muted", headingMeta(goal, Math.max(0, openGoalCount - 1)));
	return heading(theme, safeWidth, headingLeft, headingRight);
}

function goalBodyLines(goal: GoalWidgetRecord, theme: Theme, safeWidth: number): string[] {
	const body = [`${theme.fg("accent", "⟡")} ${theme.fg("text", truncateText(displayObjectiveTitle(goal.objective), Math.max(12, safeWidth - 8)))}`];
	if (goal.status === "paused" && goal.stopReason === "agent" && goal.pauseReason) appendPauseLines(body, goal, theme, safeWidth);
	const path = goal.status === "complete" ? goal.archivedPath : goal.activePath;
	if (path) body.push(theme.fg("dim", path));
	return body;
}

function appendPauseLines(body: string[], goal: GoalWidgetRecord, theme: Theme, safeWidth: number): void {
	body.push(`${theme.fg("warning", "blocker")} ${theme.fg("warning", truncateText(goal.pauseReason ?? "", Math.max(12, safeWidth - 14)))}`);
	if (goal.pauseSuggestedAction) body.push(`${theme.fg("dim", "next")} ${theme.fg("muted", truncateText(goal.pauseSuggestedAction, Math.max(12, safeWidth - 10)))}`);
}

export function renderGoalWidgetLines(goal: GoalWidgetRecord | null, theme: Theme, width: number, options: { openGoalCount?: number; auditorProgress?: AuditorWidgetProgress | null; now?: number } = {}): string[] {
	if (options.auditorProgress) return renderAuditorWidgetLines(options.auditorProgress, theme, width, { now: options.now });
	const safeWidth = Math.max(1, width);
	if (!goal) return renderUnfocusedGoalLines(options.openGoalCount ?? 0, theme, safeWidth);

	const openGoalCount = options.openGoalCount ?? 1;
	const lines: string[] = [goalHeading(goal, theme, openGoalCount, safeWidth)];
	const body = goalBodyLines(goal, theme, safeWidth);
	for (const [index, content] of body.entries()) lines.push(branchLine(theme, safeWidth, index === body.length - 1, content));
	return lines;
}

export class GoalWidgetComponent implements Component {
	private theme: Theme;
	private tui: TUI;
	private getGoal: () => GoalWidgetRecord | null;
	private getOpenGoalCount: () => number;
	private getAuditorProgress: () => AuditorWidgetProgress | null;

	constructor(options: GoalWidgetOptions) {
		this.theme = options.theme;
		this.tui = options.tui;
		this.getGoal = options.getGoal;
		this.getOpenGoalCount = options.getOpenGoalCount ?? (() => (this.getGoal() ? 1 : 0));
		this.getAuditorProgress = options.getAuditorProgress ?? (() => null);
	}

	// TUI Component lifecycle method invoked through the Component interface.
	update(): void {
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return renderGoalWidgetLines(this.getGoal(), this.theme, width, {
			openGoalCount: this.getOpenGoalCount(),
			auditorProgress: this.getAuditorProgress(),
		});
	}

	// TUI Component lifecycle method invoked through the Component interface.
	invalidate(): void {
		this.tui.requestRender();
	}
}
