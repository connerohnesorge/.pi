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


type GoalWidgetColor = Extract<ThemeColor, "accent" | "warning" | "success" | "error" | "dim" | "muted" | "text">;

export interface GoalWidgetRecord extends GoalDisplayRecordLike {
	activePath?: string | null;
	archivedPath?: string | null;
	pauseReason?: string;
	pauseSuggestedAction?: string;
}

export interface AuditorWidgetProgress {
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	recentOutput: string[];
	phase: "running" | "tool_executing" | "producing_report" | "done";
	elapsedMs: number;
}

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

function getAuditorStepInfo(progress: AuditorWidgetProgress): { label: string; percent: number } {
	if (progress.phase === "done") {
		return { label: "Audit complete!", percent: 100 };
	}
	if (progress.phase === "producing_report") {
		return { label: "Producing report...", percent: 90 };
	}

	const elapsed = progress.elapsedMs || 0;
	const tool = progress.currentTool;

	if (tool === "find" || tool === "ls") {
		return { label: "Inspecting files...", percent: 25 };
	}
	if (tool === "grep" || tool === "read") {
		return { label: "Verifying success criteria...", percent: 50 };
	}
	if (tool === "bash") {
		return { label: "Running verification tests...", percent: 75 };
	}

	if (elapsed < 3000) {
		return { label: "Inspecting files...", percent: 15 };
	}
	if (elapsed < 8000) {
		return { label: "Verifying success criteria...", percent: 40 };
	}
	if (elapsed < 14000) {
		return { label: "Running verification tests...", percent: 65 };
	}
	return { label: "Producing report...", percent: 85 };
}

export function renderAuditorWidgetLines(progress: AuditorWidgetProgress, theme: Theme, width: number): string[] {
	const safeWidth = Math.max(1, width);
	const isActive = progress.phase !== "done";
	const icon = isActive ? theme.fg("accent", spinnerFrame()) : theme.fg("success", "✓");
	const label = isActive ? "auditing" : "audit complete";
	// formatDuration expects seconds, progress.elapsedMs is in milliseconds
	const duration = formatDuration(Math.floor(progress.elapsedMs / 1000));
	const lines: string[] = [
		heading(
			theme,
			safeWidth,
			`${icon} ${theme.fg("accent", theme.bold("Goalie Audit"))} ${theme.fg("muted", label)}`,
			theme.fg("muted", duration),
		),
	];

	const step = getAuditorStepInfo(progress);
	const barStr = makeProgressBar(step.percent, Math.min(16, Math.max(8, Math.floor(safeWidth / 4))));
	lines.push(branchLine(
		theme,
		safeWidth,
		false,
		`${theme.fg("accent", step.label)}  ${theme.fg("muted", barStr)}`,
	));

	if (isActive && progress.currentTool) {
		const argText = progress.currentToolArgs
			? truncateText(progress.currentToolArgs, Math.max(10, safeWidth - 24))
			: "";
		const toolDuration = progress.currentToolStartedAt
			? ` ${theme.fg("dim", formatDuration(Date.now() - progress.currentToolStartedAt))}`
			: "";
		lines.push(branchLine(
			theme,
			safeWidth,
			false,
			`${theme.fg("accent", "tool")} ${theme.fg("text", progress.currentTool)}${argText ? ` ${theme.fg("dim", argText)}` : ""}${toolDuration}`,
		));
	}

	if (progress.recentOutput.length > 0) {
		// Show separator
		lines.push(branchLine(
			theme,
			safeWidth,
			!isActive,
			theme.fg("dim", "─".repeat(Math.max(4, safeWidth - 6))),
		));
		for (const [index, line] of progress.recentOutput.entries()) {
			const isLast = index === progress.recentOutput.length - 1 && !isActive;
			lines.push(branchLine(
				theme,
				safeWidth,
				isLast,
				theme.fg("dim", truncateText(line, Math.max(8, safeWidth - 6))),
			));
		}
	}

	// Show skip hint when audit is actively running
	if (isActive) {
		lines.push(branchLine(
			theme,
			safeWidth,
			true,
			theme.fg("warning", "Esc to skip") + theme.fg("dim", " — abort the audit and mark the goal complete"),
		));
	}

	return lines;
}

export function renderGoalWidgetLines(goal: GoalWidgetRecord | null, theme: Theme, width: number, options: { openGoalCount?: number; auditorProgress?: AuditorWidgetProgress | null } = {}): string[] {
	// When auditor progress is active, show auditor display instead of normal goal widget
	if (options.auditorProgress) {
		return renderAuditorWidgetLines(options.auditorProgress, theme, width);
	}
	if (!goal) {
		const openGoalCount = options.openGoalCount ?? 0;
		if (openGoalCount <= 0) return [];
		const safeWidth = Math.max(1, width);
		return [
			heading(theme, safeWidth, `${theme.fg("warning", "◇")} ${theme.fg("warning", theme.bold("Goal"))} ${theme.fg("muted", "unfocused")}`, theme.fg("muted", `${openGoalCount} open`)),
			branchLine(theme, safeWidth, true, `${theme.fg("muted", "Run /goal-focus to choose this session's goal")}`),
		];
	}
	const safeWidth = Math.max(1, width);
	const { icon, color, label } = displayIcon(goal);
	const mode = goal.sisyphus ? "Sisyphus" : "Goal";
	const headingLeft = `${theme.fg(color, icon)} ${theme.fg(color, theme.bold(mode))} ${theme.fg("muted", label.replace(/^sisyphus |^goal /, ""))}`;
	const otherOpenGoalCount = Math.max(0, (options.openGoalCount ?? (goal ? 1 : 0)) - 1);
	const headingRight = theme.fg("muted", headingMeta(goal, otherOpenGoalCount));
	const lines: string[] = [heading(theme, safeWidth, headingLeft, headingRight)];
	const body: string[] = [];

	const titleWidth = Math.max(12, safeWidth - 8);
	const objective = truncateText(displayObjectiveTitle(goal.objective), titleWidth);
	body.push(`${theme.fg("accent", "⟡")} ${theme.fg("text", objective)}`);

	if (goal.status === "paused" && goal.stopReason === "agent" && goal.pauseReason) {
		body.push(`${theme.fg("warning", "blocker")} ${theme.fg("warning", truncateText(goal.pauseReason, Math.max(12, safeWidth - 14)))}`);
		if (goal.pauseSuggestedAction) {
			body.push(`${theme.fg("dim", "next")} ${theme.fg("muted", truncateText(goal.pauseSuggestedAction, Math.max(12, safeWidth - 10)))}`);
		}
	}

	const path = goal.status === "complete" ? goal.archivedPath : goal.activePath;
	if (path) {
		body.push(theme.fg("dim", path));
	}

	for (const [index, content] of body.entries()) {
		lines.push(branchLine(theme, safeWidth, index === body.length - 1, content));
	}

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
