import test from "node:test";
import assert from "node:assert/strict";
import { loadPromptHistory, openPromptallHistory, registerPromptallExtension, selectPromptWithTui } from "../index.ts";
import type { PromptHistoryItem } from "../prompt-history.ts";

function prompt(id: string, text: string, timestampMs: number): PromptHistoryItem {
	return {
		id,
		text,
		normalizedText: text.toLowerCase(),
		preview: text,
		timestampMs,
		source: "saved",
	};
}

function createFakeEditor() {
	let text = "";
	let lastInput: string | undefined;
	return {
		focused: false,
		render: () => [],
		invalidate() {},
		handleInput(data: string) {
			lastInput = data;
		},
		getText: () => text,
		setText(next: string) {
			text = next;
		},
		getExpandedText: () => text,
		get lastInput() {
			return lastInput;
		},
	};
}

function createHarness(options: { mode?: string; prompts?: PromptHistoryItem[]; selected?: PromptHistoryItem | null } = {}) {
	const commands = new Map<string, any>();
	const shortcuts = new Map<string, any>();
	const events = new Map<string, any[]>();
	const baseEditor = createFakeEditor();
	let editorFactory: any = () => baseEditor;
	let loadCalls = 0;
	let selectCalls = 0;
	let editorText = "existing editor text";
	const notifications: Array<{ message: string; type: string }> = [];

	const pi = {
		on(name: string, handler: any) {
			const handlers = events.get(name) ?? [];
			handlers.push(handler);
			events.set(name, handlers);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		registerShortcut(shortcut: string, shortcutHandler: any) {
			shortcuts.set(shortcut, shortcutHandler);
		},
	};

	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: (options.mode ?? "tui") === "tui",
		cwd: "/work/current",
		sessionManager: {
			getBranch: () => [],
			getSessionFile: () => "/tmp/current.jsonl",
			getSessionName: () => "Current session",
		},
		ui: {
			notify(message: string, type: string) {
				notifications.push({ message, type });
			},
			setEditorText(text: string) {
				editorText = text;
			},
			getEditorComponent() {
				return editorFactory;
			},
			setEditorComponent(factory: any) {
				editorFactory = factory;
			},
		},
	};

	registerPromptallExtension(pi as any, {
		loadHistory: async () => {
			loadCalls += 1;
			return options.prompts ?? [];
		},
		selectPrompt: async (_ctx, prompts) => {
			selectCalls += 1;
			return options.selected === undefined ? prompts[0] ?? null : options.selected;
		},
	});

	async function emit(name: string, event: any = {}) {
		for (const handler of events.get(name) ?? []) {
			await handler(event, ctx);
		}
	}

	return {
		commands,
		shortcuts,
		events,
		ctx,
		notifications,
		baseEditor,
		emit,
		createEditor: () =>
			editorFactory(
				{ requestRender() {} },
				{
					borderColor: (text: string) => text,
					selectList: {
						selectedPrefix: (text: string) => text,
						selectedText: (text: string) => text,
						description: (text: string) => text,
						scrollInfo: (text: string) => text,
						noMatch: (text: string) => text,
					},
				},
				{ matches: () => false },
			),
		get editorText() {
			return editorText;
		},
		get loadCalls() {
			return loadCalls;
		},
		get selectCalls() {
			return selectCalls;
		},
	};
}

test("runtime registers /promptall command and avoids global Ctrl+R shortcut conflict", () => {
	const h = createHarness();
	assert.equal(h.shortcuts.has("ctrl+r"), false);
	assert.ok(h.commands.has("promptall"));
	assert.ok(h.events.has("session_start"));
});

test("/promptall inserts the selected prompt without submitting it", async () => {
	const selected = prompt("p1", "reuse this prompt", 2000);
	const h = createHarness({ prompts: [selected] });

	await h.commands.get("promptall").handler("", h.ctx);

	assert.equal(h.editorText, "reuse this prompt");
	assert.equal(h.loadCalls, 1);
	assert.equal(h.selectCalls, 1);
	assert.match(h.notifications.at(-1)?.message ?? "", /Prompt inserted/);
});

test("Ctrl+R editor binding uses the same prompt insertion flow", async () => {
	const selected = prompt("p1", "from editor shortcut", 2000);
	const h = createHarness({ prompts: [selected] });

	await h.emit("session_start");
	const editor = h.createEditor();
	editor.handleInput("\x12");
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(h.editorText, "from editor shortcut");
	assert.equal(h.loadCalls, 1);
	assert.equal(h.selectCalls, 1);
});

test("cancel leaves the editor unchanged", async () => {
	const h = createHarness({ prompts: [prompt("p1", "unused", 2000)], selected: null });

	await h.commands.get("promptall").handler("", h.ctx);

	assert.equal(h.editorText, "existing editor text");
	assert.equal(h.loadCalls, 1);
	assert.equal(h.selectCalls, 1);
});

test("non-TUI mode is rejected before loading history", async () => {
	const h = createHarness({ mode: "print", prompts: [prompt("p1", "unused", 2000)] });

	await h.commands.get("promptall").handler("", h.ctx);

	assert.equal(h.editorText, "existing editor text");
	assert.equal(h.loadCalls, 0);
	assert.equal(h.selectCalls, 0);
	assert.match(h.notifications.at(-1)?.message ?? "", /requires interactive TUI mode/);
});

test("openPromptallHistory reports empty history", async () => {
	const h = createHarness({ prompts: [] });

	await openPromptallHistory(h.ctx as any, {
		loadHistory: async () => [],
		selectPrompt: async () => {
			throw new Error("selector should not run");
		},
	});

	assert.equal(h.editorText, "existing editor text");
	assert.match(h.notifications.at(-1)?.message ?? "", /No prior text prompts/);
});

test("selectPromptWithTui filters by typed search before selecting", async () => {
	const prompts = [prompt("p1", "write docs", 1000), prompt("p2", "deploy billing worker", 2000)];
	const ctx = {
		ui: {
			custom(factory: any) {
				return new Promise((resolve) => {
					const component = factory(
						{ requestRender() {} },
						{
							fg: (_color: string, text: string) => text,
							bold: (text: string) => text,
						},
						{
							matches(data: string, keybinding: string) {
								return keybinding === "tui.select.confirm" && data === "enter";
							},
						},
						resolve,
					);
					component.handleInput("billing");
					component.handleInput("enter");
				});
			},
		},
	};

	const selected = await selectPromptWithTui(ctx as any, prompts);
	assert.equal(selected?.text, "deploy billing worker");
});


test("loadPromptHistory reads saved sessions and current branch newest first", async () => {
	const savedSession = [
		JSON.stringify({ type: "session", id: "s1", version: 3 }),
		JSON.stringify({
			type: "message",
			id: "old",
			message: { role: "user", content: "old saved", timestamp: 1000 },
		}),
		JSON.stringify({
			type: "message",
			id: "dupe",
			message: { role: "user", content: "duplicate", timestamp: 2000 },
		}),
	].join("\n");

	const ctx = {
		cwd: "/work/current",
		sessionManager: {
			getBranch: () => [
				{
					type: "message",
					id: "current",
					message: { role: "user", content: "current prompt", timestamp: 4000 },
				},
				{
					type: "message",
					id: "new-dupe",
					message: { role: "user", content: " duplicate ", timestamp: 3000 },
				},
			],
			getSessionFile: () => "/tmp/current.jsonl",
			getSessionName: () => "Current",
		},
	};

	const history = await loadPromptHistory(ctx as any, {
		listSessions: async () => [
			{
				path: "/tmp/saved.jsonl",
				id: "s1",
				cwd: "/work/saved",
				created: new Date(0),
				modified: new Date(2000),
				messageCount: 2,
				firstMessage: "old saved",
				allMessagesText: "old saved duplicate",
			},
		] as any,
		readSessionFile: async () => savedSession,
	});

	assert.deepEqual(
		history.map((item) => item.text),
		["current prompt", "duplicate", "old saved"],
	);
	assert.equal(history[1]?.source, "current");
});
