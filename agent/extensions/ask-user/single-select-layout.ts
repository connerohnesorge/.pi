export interface QuestionOption {
	title: string;
	description?: string;
}

export interface AnnotatedRow {
	line: string;
	selected: boolean;
}

// The kind of a visible row, and (for options) which option it maps to.
export type SelectionRowKind =
	| { kind: "option"; optionIndex: number }
	| { kind: "comment-toggle" }
	| { kind: "freeform" };

export interface SelectionRowModelInput {
	// Count of currently-VISIBLE options. Callers pass the raw option count
	// (full list) or the filtered count (searched viewport) — the ordering and
	// classification logic is identical either way.
	optionCount: number;
	allowComment: boolean;
	allowFreeform: boolean;
}

export interface SelectionRowModel {
	readonly count: number; // options + comment? + freeform?
	readonly commentToggleIndex: number | null;
	readonly freeformIndex: number | null;
	classify(index: number): SelectionRowKind | null; // null when out of range
	isCommentToggleRow(index: number): boolean;
	isFreeformRow(index: number): boolean;
	isOptionRow(index: number): boolean;
}

/**
 * The single source of truth for the `ask_user` selection list's row order,
 * count, and index→kind classification. The canonical order is `option*`, then
 * the comment-toggle row (iff `allowComment`), then the freeform row (iff
 * `allowFreeform`). Parameterized by `optionCount` so the full-list and
 * fuzzy-filtered components share identical logic.
 */
export function buildSelectionRowModel(input: SelectionRowModelInput): SelectionRowModel {
	const { optionCount, allowComment, allowFreeform } = input;
	const commentToggleIndex = allowComment ? optionCount : null;
	const freeformIndex = allowFreeform ? optionCount + (allowComment ? 1 : 0) : null;
	const count = optionCount + (allowComment ? 1 : 0) + (allowFreeform ? 1 : 0);

	const classify = (index: number): SelectionRowKind | null => {
		if (index < 0 || index >= count) return null;
		if (commentToggleIndex !== null && index === commentToggleIndex) return { kind: "comment-toggle" };
		if (freeformIndex !== null && index === freeformIndex) return { kind: "freeform" };
		return { kind: "option", optionIndex: index };
	};

	return {
		count,
		commentToggleIndex,
		freeformIndex,
		classify,
		isCommentToggleRow: (index) => classify(index)?.kind === "comment-toggle",
		isFreeformRow: (index) => classify(index)?.kind === "freeform",
		isOptionRow: (index) => classify(index)?.kind === "option",
	};
}

export interface RenderSingleSelectRowsParams {
	options: QuestionOption[];
	selectedIndex: number;
	width: number;
	allowFreeform: boolean;
	allowComment?: boolean;
	commentEnabled?: boolean;
	maxRows?: number;
	hideDescriptions?: boolean;
}

function splitLongWord(word: string, width: number): { lines: string[]; remainder: string } {
	const lines: string[] = [];
	let remainder = "";
	for (let i = 0; i < word.length; i += width) {
		const chunk = word.slice(i, i + width);
		if (chunk.length === width || i + width < word.length) lines.push(chunk);
		else remainder = chunk;
	}
	return { lines, remainder };
}

function startWrappedLine(word: string, width: number, lines: string[]): string {
	if (word.length <= width) return word;
	lines.push(...splitLongWord(word, width).lines);
	return "";
}

function wrapText(text: string, width: number): string[] {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized) return [""];
	if (width <= 1) return normalized.split("");

	const lines: string[] = [];
	let current = "";
	for (const word of normalized.split(" ")) {
		if (!current) {
			current = startWrappedLine(word, width, lines);
			continue;
		}

		const candidate = `${current} ${word}`;
		if (candidate.length <= width) {
			current = candidate;
			continue;
		}

		lines.push(current);
		if (word.length <= width) current = word;
		else {
			const split = splitLongWord(word, width);
			lines.push(...split.lines);
			current = split.remainder;
		}
	}

	if (current) lines.push(current);
	return lines;
}

function padLine(prefix: string, content: string): string {
	return `${prefix}${content}`.trimEnd();
}

interface ItemBlock {
	itemIndex: number;
	lines: string[];
}

type ListItem =
	| { type: "option"; option: QuestionOption }
	| { type: "comment-toggle"; option: QuestionOption }
	| { type: "freeform"; option: QuestionOption };

function buildItemBlocks(
	options: QuestionOption[],
	width: number,
	allowFreeform: boolean,
	allowComment: boolean,
	commentEnabled: boolean,
	selectedIndex: number,
	hideDescriptions = false,
): ItemBlock[] {
	const normalizedWidth = Math.max(12, width);
	const freeformLabel = "Type something. — Enter a custom response";
	const commentToggleLabel = `${commentEnabled ? "[✓]" : "[ ]"} Add extra context after selection`;
	const model = buildSelectionRowModel({ optionCount: options.length, allowComment, allowFreeform });
	const allItems: ListItem[] = Array.from({ length: model.count }, (_, index): ListItem => {
		const kind = model.classify(index);
		if (kind?.kind === "comment-toggle") return { type: "comment-toggle", option: { title: commentToggleLabel } };
		if (kind?.kind === "freeform") return { type: "freeform", option: { title: freeformLabel } };
		return { type: "option", option: options[kind?.kind === "option" ? kind.optionIndex : index]! };
	});

	return allItems.map((item, itemIndex) => {
		const pointer = itemIndex === selectedIndex ? "→" : " ";
		const lines: string[] = [];

		if (item.type === "comment-toggle" || item.type === "freeform") {
			const prefix = `${pointer}   `;
			const wrapped = wrapText(item.option.title, Math.max(8, normalizedWidth - prefix.length));
			wrapped.forEach((line, lineIndex) => {
				lines.push(padLine(lineIndex === 0 ? prefix : " ".repeat(prefix.length), line));
			});
			return { itemIndex, lines };
		}

		const numberPrefix = `${pointer} ${itemIndex + 1}. `;
		const continuationPrefix = " ".repeat(numberPrefix.length);
		const titleLines = wrapText(item.option.title, Math.max(8, normalizedWidth - numberPrefix.length));
		titleLines.forEach((line, lineIndex) => {
			lines.push(padLine(lineIndex === 0 ? numberPrefix : continuationPrefix, line));
		});

		if (item.option.description && !hideDescriptions) {
			const descriptionPrefix = "      ";
			const descriptionLines = wrapText(
				item.option.description,
				Math.max(8, normalizedWidth - descriptionPrefix.length),
			);
			descriptionLines.forEach((line) => {
				lines.push(padLine(descriptionPrefix, line));
			});
		}

		return { itemIndex, lines };
	});
}

function flatten(blocks: ItemBlock[], selectedIndex: number): AnnotatedRow[] {
	return blocks.flatMap((block) =>
		block.lines.map((line) => ({
			line,
			selected: block.itemIndex === selectedIndex,
		})),
	);
}

interface RowWindow {
	start: number;
	end: number;
}

function renderSelectedBlockOnly(block: ItemBlock, availableRows: number, safeMaxRows: number, indicator: string): AnnotatedRow[] {
	const visible = block.lines.slice(0, availableRows).map((line) => ({ line, selected: true }));
	if (safeMaxRows > 1) visible.push({ line: indicator, selected: false });
	return visible.slice(0, safeMaxRows);
}

function expandRowWindow(blocks: ItemBlock[], selectedIndex: number, availableRows: number): RowWindow {
	let start = selectedIndex;
	let end = selectedIndex + 1;
	let usedRows = blocks[selectedIndex]?.lines.length ?? 0;

	while (true) {
		const next = blocks[end];
		if (next && usedRows + next.lines.length <= availableRows) {
			usedRows += next.lines.length;
			end += 1;
			continue;
		}

		const previous = blocks[start - 1];
		if (previous && usedRows + previous.lines.length <= availableRows) {
			start -= 1;
			usedRows += previous.lines.length;
			continue;
		}

		return { start, end };
	}
}

function limitSingleSelectRows(
	blocks: ItemBlock[],
	selectedIndex: number,
	itemCount: number,
	maxRows: number,
): AnnotatedRow[] {
	const safeMaxRows = Math.max(1, Math.floor(maxRows));
	const selectedBlock = blocks[selectedIndex] ?? blocks[0];
	if (!selectedBlock) return [];

	const indicator = `  (${selectedIndex + 1}/${itemCount})`;
	const availableRows = safeMaxRows > 1 ? safeMaxRows - 1 : 1;
	if (selectedBlock.lines.length >= availableRows) {
		return renderSelectedBlockOnly(selectedBlock, availableRows, safeMaxRows, indicator);
	}

	const { start, end } = expandRowWindow(blocks, selectedIndex, availableRows);
	const visible = flatten(blocks.slice(start, end), selectedIndex);
	visible.push({ line: indicator, selected: false });
	return visible.slice(0, safeMaxRows);
}

function renderSingleSelectRowsInternal(params: Required<Omit<RenderSingleSelectRowsParams, "maxRows" | "hideDescriptions">> & Pick<RenderSingleSelectRowsParams, "maxRows" | "hideDescriptions">): AnnotatedRow[] {
	const { options, selectedIndex, width, allowFreeform, allowComment, commentEnabled, maxRows, hideDescriptions } = params;
	const itemCount = buildSelectionRowModel({ optionCount: options.length, allowComment, allowFreeform }).count;
	const blocks = buildItemBlocks(options, width, allowFreeform, allowComment, commentEnabled, selectedIndex, hideDescriptions);
	const allRows = flatten(blocks, selectedIndex);
	return !Number.isFinite(maxRows) || !maxRows || maxRows <= 0 || allRows.length <= maxRows
		? allRows
		: limitSingleSelectRows(blocks, selectedIndex, itemCount, maxRows);
}

export function renderSingleSelectRows(params: RenderSingleSelectRowsParams): AnnotatedRow[] {
	return renderSingleSelectRowsInternal({ ...params, allowComment: params.allowComment ?? false, commentEnabled: params.commentEnabled ?? false });
}
