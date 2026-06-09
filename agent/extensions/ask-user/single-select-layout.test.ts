import { describe, expect, test } from "bun:test";
import { buildSelectionRowModel, renderSingleSelectRows } from "./single-select-layout";

describe("buildSelectionRowModel", () => {
	test("both comment-toggle and freeform: appends them after the options in canonical order", () => {
		const model = buildSelectionRowModel({ optionCount: 3, allowComment: true, allowFreeform: true });

		expect(model.count).toBe(5);
		expect(model.commentToggleIndex).toBe(3);
		expect(model.freeformIndex).toBe(4);

		expect(model.classify(0)).toEqual({ kind: "option", optionIndex: 0 });
		expect(model.classify(2)).toEqual({ kind: "option", optionIndex: 2 });
		expect(model.classify(3)).toEqual({ kind: "comment-toggle" });
		expect(model.classify(4)).toEqual({ kind: "freeform" });

		expect(model.isOptionRow(2)).toBe(true);
		expect(model.isCommentToggleRow(3)).toBe(true);
		expect(model.isFreeformRow(4)).toBe(true);
		expect(model.isFreeformRow(3)).toBe(false);
		expect(model.isCommentToggleRow(4)).toBe(false);
	});

	test("comment-only: freeform index is null and the comment-toggle is the last row", () => {
		const model = buildSelectionRowModel({ optionCount: 3, allowComment: true, allowFreeform: false });

		expect(model.count).toBe(4);
		expect(model.commentToggleIndex).toBe(3);
		expect(model.freeformIndex).toBeNull();

		expect(model.classify(3)).toEqual({ kind: "comment-toggle" });
		expect(model.isCommentToggleRow(3)).toBe(true);
		expect(model.isFreeformRow(3)).toBe(false);
	});

	test("freeform-only: comment-toggle index is null and freeform sits immediately after the options", () => {
		const model = buildSelectionRowModel({ optionCount: 3, allowComment: false, allowFreeform: true });

		expect(model.count).toBe(4);
		expect(model.commentToggleIndex).toBeNull();
		expect(model.freeformIndex).toBe(3);

		expect(model.classify(3)).toEqual({ kind: "freeform" });
		expect(model.isFreeformRow(3)).toBe(true);
		expect(model.isCommentToggleRow(3)).toBe(false);
	});

	test("neither flag: every in-range index is an option row", () => {
		const model = buildSelectionRowModel({ optionCount: 3, allowComment: false, allowFreeform: false });

		expect(model.count).toBe(3);
		expect(model.commentToggleIndex).toBeNull();
		expect(model.freeformIndex).toBeNull();

		for (let i = 0; i < model.count; i++) {
			expect(model.classify(i)).toEqual({ kind: "option", optionIndex: i });
			expect(model.isOptionRow(i)).toBe(true);
		}
	});

	test("zero options: only the synthetic rows exist, in canonical order", () => {
		const both = buildSelectionRowModel({ optionCount: 0, allowComment: true, allowFreeform: true });
		expect(both.count).toBe(2);
		expect(both.commentToggleIndex).toBe(0);
		expect(both.freeformIndex).toBe(1);
		expect(both.classify(0)).toEqual({ kind: "comment-toggle" });
		expect(both.classify(1)).toEqual({ kind: "freeform" });

		const none = buildSelectionRowModel({ optionCount: 0, allowComment: false, allowFreeform: false });
		expect(none.count).toBe(0);
		expect(none.commentToggleIndex).toBeNull();
		expect(none.freeformIndex).toBeNull();
		expect(none.classify(0)).toBeNull();
	});

	test("out-of-range indices classify as null and the predicates are false", () => {
		const model = buildSelectionRowModel({ optionCount: 3, allowComment: true, allowFreeform: true });

		expect(model.classify(-1)).toBeNull();
		expect(model.classify(5)).toBeNull();
		expect(model.classify(model.count)).toBeNull();

		expect(model.isOptionRow(-1)).toBe(false);
		expect(model.isCommentToggleRow(5)).toBe(false);
		expect(model.isFreeformRow(5)).toBe(false);
	});
});

describe("renderSingleSelectRows", () => {
	test("wraps long option titles instead of truncating them away", () => {
		const rows = renderSingleSelectRows({
			options: [
				{
					title:
						"I want help with a coding or implementation task that involves changing, creating, reviewing, refactoring, or understanding code in a project",
				},
			],
			selectedIndex: 0,
			width: 40,
			allowFreeform: false,
		});

		expect(rows.length).toBeGreaterThan(1);
		expect(rows.map((r) => r.line).join(" ")).toContain("implementation task");
		expect(rows.map((r) => r.line).join(" ")).toContain("understanding code");
	});

	test("wraps long descriptions under their option instead of clipping them", () => {
		const rows = renderSingleSelectRows({
			options: [
				{
					title: "Planning help",
					description:
						"Choose this if you are still deciding what to do, want a plan first, need architecture guidance, or want to evaluate alternatives before touching code.",
				},
			],
			selectedIndex: 0,
			width: 44,
			allowFreeform: false,
		});

		const rendered = rows.map((r) => r.line).join(" ").replace(/\s+/g, " ").trim();
		expect(rendered).toContain("want a plan first");
		expect(rendered).toContain("before touching code");
		expect(rows.length).toBeGreaterThan(2);
	});

	test("caps the rendered rows and keeps the selected option visible when content is taller than the viewport", () => {
		const rows = renderSingleSelectRows({
			options: [
				{
					title:
						"I want help with a coding or implementation task that involves changing, creating, reviewing, refactoring, or understanding code in a project",
					description:
						"Choose this if your main goal is to build something, fix code, understand existing code, add a feature, improve architecture, write tests, or get help with development work.",
				},
				{
					title:
						"I want help troubleshooting, debugging, diagnosing, reproducing, isolating, or explaining a bug, failure, regression, flaky test, unexpected behavior, runtime error, build issue, deployment problem, configuration mistake, performance bottleneck, or environment-specific issue",
					description:
						"Choose this if something is broken, inconsistent, failing, slow, confusing, or behaving differently than expected and you want systematic help narrowing it down.",
				},
			],
			selectedIndex: 1,
			width: 44,
			allowFreeform: false,
			maxRows: 6,
		});

		expect(rows.length).toBeLessThanOrEqual(6);
		expect(rows.map((r) => r.line).join(" ").replace(/\s+/g, " ")).toContain("troubleshooting");
	});

	test("does not duplicate a short word after wrapping an exact-width long word", () => {
		const rows = renderSingleSelectRows({
			options: [
				{
					title: "Alpha",
					description: "hi aaaaaaaaaaaaaaaa",
				},
			],
			selectedIndex: 0,
			width: 12,
			allowFreeform: false,
		});

		expect(rows.map((r) => r.line).filter((line) => line.trim() === "hi")).toHaveLength(1);
		expect(rows.map((r) => r.line).filter((line) => line.trim() === "aaaaaaaa")).toHaveLength(2);
	});

	test("marks selected item rows as selected in annotated output", () => {
		const rows = renderSingleSelectRows({
			options: [
				{ title: "Alpha" },
				{ title: "Beta with a very long title that should wrap to multiple lines when rendered" },
				{ title: "Gamma" },
			],
			selectedIndex: 1,
			width: 30,
			allowFreeform: false,
		});

		const selectedRows = rows.filter((r) => r.selected);
		const nonSelectedRows = rows.filter((r) => !r.selected);

		expect(selectedRows.length).toBeGreaterThan(1);
		for (const row of selectedRows) {
			expect(row.line).not.toContain("Alpha");
			expect(row.line).not.toContain("Gamma");
		}
		expect(nonSelectedRows.length).toBeGreaterThan(0);
	});
});
