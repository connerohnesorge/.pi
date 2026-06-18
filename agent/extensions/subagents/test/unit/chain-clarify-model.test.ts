import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { AgentConfig } from "../../src/agents/agents.ts";
import { ChainClarifyComponent } from "../../src/runs/foreground/chain-clarify.ts";
import { ChainClarifyModel, type ChainClarifyModelOptions, type ChainClarifyResult } from "../../src/runs/foreground/chain-clarify-model.ts";
import type { ResolvedStepBehavior } from "../../src/shared/settings.ts";

function agent(name: string): AgentConfig {
	return {
		name,
		description: "",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: `${name}.md`,
	};
}

function behavior(overrides: Partial<ResolvedStepBehavior> = {}): ResolvedStepBehavior {
	return {
		output: false,
		outputMode: "inline",
		reads: false,
		progress: false,
		skills: [],
		model: undefined,
		...overrides,
	};
}

function createModel(overrides: Partial<ChainClarifyModelOptions> = {}): ChainClarifyModel {
	return new ChainClarifyModel({
		agentConfigs: [agent("scout"), agent("worker")],
		templates: ["first task\nsecond line", "read {previous}"],
		originalTask: "original",
		chainDir: "/tmp/chain",
		resolvedBehaviors: [
			behavior({ output: "old.md", model: "test/reasoning", skills: ["existing"] }),
			behavior({ reads: ["old.md"], model: "test/basic" }),
		],
		availableModels: [
			{ provider: "test", id: "reasoning", fullId: "test/reasoning", reasoning: true },
			{ provider: "test", id: "basic", fullId: "test/basic", reasoning: false },
		],
		preferredProvider: "test",
		availableSkills: [
			{ name: "existing", source: "user" },
			{ name: "new-skill", source: "project", description: "new behavior" },
		],
		mode: "chain",
		...overrides,
	});
}

describe("ChainClarifyModel", () => {
	it("edits task text without constructing the terminal adapter", () => {
		const model = createModel();

		model.enterEditMode("template");
		model.editState = { buffer: "updated task", cursor: "updated task".length, viewportOffset: 0 };
		const action = model.handleEditInput("\x1b", 80, 12);

		assert.equal(action.kind, "render");
		assert.equal(model.editingStep, null);
		assert.deepEqual(model.templates, ["updated task\nsecond line", "read {previous}"]);
	});

	it("updates output overrides and propagates downstream reads without rendering", () => {
		const model = createModel();

		model.enterEditMode("output");
		model.editState = { buffer: "new.md", cursor: "new.md".length, viewportOffset: 0 };
		model.handleEditInput("\x1b", 80, 12);

		assert.equal(model.behaviorOverrides.get(0)?.output, "new.md");
		assert.deepEqual(model.behaviorOverrides.get(1)?.reads, ["new.md"]);
		const reads = model.getEffectiveBehavior(1).reads;
		assert.ok(Array.isArray(reads));
		assert.equal(reads[0], "new.md");
	});

	it("builds the same confirmed result after progress, model, thinking, and skills transitions", () => {
		const model = createModel();

		model.handleInput("p", 80, 12);
		assert.equal(model.getEffectiveBehavior(0).progress, true);
		assert.equal(model.getEffectiveBehavior(1).progress, true);

		model.selectedStep = 1;
		model.enterModelSelector();
		model.modelSelectedIndex = model.filteredModels.findIndex((candidate) => candidate.fullId === "test/reasoning");
		model.handleModelSelectorInput("\r");
		assert.equal(model.getEffectiveModel(1), "test/reasoning");

		model.enterThinkingSelector();
		model.applyThinkingLevel("high");
		assert.equal(model.getEffectiveModel(1), "test/reasoning:high");

		model.enterSkillSelector();
		model.skillCursorIndex = model.filteredSkills.findIndex((skill) => skill.name === "new-skill");
		model.handleSkillSelectorInput(" ");
		model.handleSkillSelectorInput("\r");

		const result = model.confirmResult();
		assert.equal(result.confirmed, true);
		assert.equal(result.templates, model.templates);
		assert.equal(result.behaviorOverrides[0]?.progress, true);
		assert.equal(result.behaviorOverrides[1]?.progress, true);
		assert.equal(result.behaviorOverrides[1]?.model, "test/reasoning:high");
		assert.deepEqual(result.behaviorOverrides[1]?.skills, ["new-skill"]);
	});

	it("returns explicit actions for top-level navigation, confirmation, cancellation, and mode gates", () => {
		const model = createModel();

		assert.equal(model.handleInput("\x1b[B", 80, 12).kind, "render");
		assert.equal(model.selectedStep, 1);
		assert.equal(model.handleInput("\x1b[B", 80, 12).kind, "render");
		assert.equal(model.selectedStep, 1);
		assert.equal(model.handleInput("\x1b[A", 80, 12).kind, "render");
		assert.equal(model.selectedStep, 0);

		assert.equal(model.handleInput("b", 80, 12).kind, "render");
		assert.equal(model.runInBackground, true);

		const confirm = model.handleInput("\r", 80, 12);
		assert.equal(confirm.kind, "confirm");
		if (confirm.kind === "confirm") {
			assert.equal(confirm.result.confirmed, true);
			assert.equal(confirm.result.runInBackground, true);
		}

		const cancel = model.handleInput("\x1b", 80, 12);
		assert.equal(cancel.kind, "cancel");
		if (cancel.kind === "cancel") {
			assert.deepEqual(cancel.result, { confirmed: false, templates: [], behaviorOverrides: [] });
		}

		const parallel = createModel({ mode: "parallel" });
		assert.equal(parallel.handleInput("w", 80, 12).kind, "none");
		assert.equal(parallel.editingStep, null);
		assert.equal(parallel.handleInput("p", 80, 12).kind, "none");
		assert.equal(parallel.getEffectiveBehavior(0).progress, false);
		assert.equal(parallel.handleInput("r", 80, 12).kind, "none");
		assert.equal(parallel.editingStep, null);
	});

	it("returns a notice instead of entering thinking selection when no model is configured", () => {
		const model = createModel({
			resolvedBehaviors: [behavior({ model: undefined }), behavior({ model: undefined })],
		});

		const action = model.handleInput("t", 80, 12);

		assert.deepEqual(action, { kind: "notice", text: "Select a model first", noticeType: "error" });
		assert.equal(model.editingStep, null);
	});

	it("terminal adapter applies model actions to render requests and completion callbacks", () => {
		let renderCount = 0;
		const results: ChainClarifyResult[] = [];
		const component = new ChainClarifyComponent(
			{ requestRender() { renderCount++; } },
			{ fg(_key: string, text: string) { return text; } },
			[agent("worker")],
			["Task"],
			"Task",
			undefined,
			[behavior({ model: "test/reasoning" })],
			[{ provider: "test", id: "reasoning", fullId: "test/reasoning", reasoning: true }],
			"test",
			[],
			(result) => results.push(result),
			"single",
		);

		component.handleInput("b");
		assert.equal(renderCount, 1);
		component.handleInput("\r");
		assert.equal(results[0]?.confirmed, true);
		assert.equal(results[0]?.runInBackground, true);

		const cancelled: ChainClarifyResult[] = [];
		const cancelComponent = new ChainClarifyComponent(
			{ requestRender() {} },
			{ fg(_key: string, text: string) { return text; } },
			[agent("worker")],
			["Task"],
			"Task",
			undefined,
			[behavior()],
			[],
			undefined,
			[],
			(result) => cancelled.push(result),
			"single",
		);
		cancelComponent.handleInput("\x1b");
		assert.deepEqual(cancelled[0], { confirmed: false, templates: [], behaviorOverrides: [] });

		let noticeRenderCount = 0;
		const noticeComponent = new ChainClarifyComponent(
			{ requestRender() { noticeRenderCount++; } },
			{ fg(_key: string, text: string) { return text; } },
			[agent("worker")],
			["Task"],
			"Task",
			undefined,
			[behavior({ model: undefined })],
			[],
			undefined,
			[],
			() => {},
			"single",
		);
		noticeComponent.handleInput("t");
		assert.equal(noticeRenderCount, 1);
		assert.match(noticeComponent.render(84).join("\n"), /Select a model first/);
		noticeComponent.dispose();
	});
});
