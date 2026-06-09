import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderGoalWidgetLines, renderAuditorWidgetLines, type GoalWidgetRecord, type AuditorWidgetProgress } from "../extensions/widgets/goal-widget.ts";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as Theme;

function goal(overrides: Partial<GoalWidgetRecord> = {}): GoalWidgetRecord {
	return {
		objective: "=== Goal ===\nObjective: Componentize the goal widget\nSuccess criteria: tests pass",
		status: "active",
		autoContinue: true,
		usage: { activeSeconds: 65, tokensUsed: 2500 },
		sisyphus: true,
		activePath: ".pi/goals/active_goal.md",
		...overrides,
	};
}

function auditorProgress(overrides: Partial<AuditorWidgetProgress> = {}): AuditorWidgetProgress {
	return {
		currentTool: "read",
		currentToolArgs: '{"path":"test.txt"}',
		currentToolStartedAt: Date.now() - 5000,
		recentOutput: ["checking file exists...", "confirming test coverage..."],
		phase: "tool_executing",
		elapsedMs: 5000,
		...overrides,
	};
}

test("renderGoalWidgetLines renders a distinct Sisyphus goal beacon", () => {
	const lines = renderGoalWidgetLines(goal(), theme, 100);
	assert.match(lines[0], /^◆ Sisyphus running/);
	assert.match(lines[0], /auto · 1m05s · 2\.5K/);
	assert.doesNotMatch(lines[0], /▰|▱/);
	assert.match(lines[1], /^├─ ⟡ Componentize the goal widget/);
	assert.doesNotMatch(lines.join("\n"), /pulse/);
	assert.match(lines.at(-1) ?? "", /^└─ \.pi\/goals\/active_goal\.md/);
});

test("renderGoalWidgetLines merges complete usage into the heading", () => {
	const lines = renderGoalWidgetLines(goal({
		status: "complete",
		autoContinue: false,
		sisyphus: false,
		archivedPath: ".pi/goals/archived/goal.md",
	}), theme, 100);
	assert.match(lines[0], /^✓ Goal complete/);
	assert.match(lines[0], /1m05s · 2\.5K/);
	assert.doesNotMatch(lines.join("\n"), /pulse/);
});


test("renderGoalWidgetLines highlights agent blockers and suggested action", () => {
	const lines = renderGoalWidgetLines(goal({
		status: "paused",
		autoContinue: false,
		stopReason: "agent",
		pauseReason: "Missing API token",
		pauseSuggestedAction: "Set TOKEN and run /goal-resume",
	}), theme, 100);
	assert.match(lines[0], /⊘ Sisyphus blocked/);
	assert.match(lines.join("\n"), /^├─ blocker Missing API token/m);
	assert.match(lines.join("\n"), /^├─ next Set TOKEN and run \/goal-resume/m);
});

test("renderGoalWidgetLines shows other open goals and unfocused multi-goal guidance", () => {
	const focused = renderGoalWidgetLines(goal(), theme, 100, { openGoalCount: 3 });
	assert.match(focused[0], /\+2 open/);

	const unfocused = renderGoalWidgetLines(null, theme, 100, { openGoalCount: 2 });
	assert.match(unfocused[0], /^◇ Goal unfocused/);
	assert.match(unfocused[0], /2 open/);
	assert.match(unfocused.join("\n"), /\/goal-focus/);
});

test("renderAuditorWidgetLines shows auditor progress with current tool", () => {
	const progress = auditorProgress();
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	// Should show audit heading with duration (5s)
	assert.match(lines[0], /Audit/);
	assert.match(lines[0], /auditing/);
	// Should show current tool
	assert.match(lines.join("\n"), /tool.*read.*test\.txt/);
	// Should show recent output lines
	assert.match(lines.join("\n"), /checking file exists/);
	assert.match(lines.join("\n"), /confirming test coverage/);
});

test("renderAuditorWidgetLines shows done phase with success icon", () => {
	const progress = auditorProgress({ phase: "done", currentTool: undefined, currentToolArgs: undefined });
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	assert.match(lines[0], /✓.*audit complete/);
	assert.doesNotMatch(lines.join("\n"), /tool/);
});

test("renderAuditorWidgetLines handles empty recent output", () => {
	const progress = auditorProgress({ recentOutput: [], phase: "running" });
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	assert.match(lines[0], /Audit.*auditing/);
	// Should have heading + tool line, but no separator dash line (which contains 4+ ─ characters)
	assert.equal(lines.filter((l) => l.includes("────")).length, 0);
});

test("auditor progress overrides normal goal display when provided", () => {
	// When auditorProgress is passed to renderGoalWidgetLines, should show auditor instead of goal
	const progress = auditorProgress();
	const lines = renderGoalWidgetLines(goal(), theme, 100, { auditorProgress: progress });
	assert.match(lines[0], /Audit/);
	assert.doesNotMatch(lines[0], /Sisyphus|\bGoal\b/);
});

test("renderAuditorWidgetLines shows Esc to skip hint when audit is active", () => {
	const progress = auditorProgress({ phase: "running" });
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	// The skip hint should appear when audit is actively running
	const allText = lines.join("\n");
	assert.match(allText, /Esc to skip/);
	assert.match(allText, /abort the audit/);
	// Skip hint should be on the last line (closing branch)
	assert.match(lines[lines.length - 1], /Esc to skip/);
});

test("renderAuditorWidgetLines omits skip hint when audit is done", () => {
	const progress = auditorProgress({ phase: "done" });
	const lines = renderAuditorWidgetLines(progress, theme, 100);
	const allText = lines.join("\n");
	assert.doesNotMatch(allText, /Esc to skip/);
	assert.doesNotMatch(allText, /abort the audit/);
});
