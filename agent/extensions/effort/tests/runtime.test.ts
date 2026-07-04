import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeRegistries } from "../../tests/runtime-harness.ts";
import effortExtension from "../index.ts";

type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const xhighModel = {
  id: "gpt-5.4",
  provider: "openai-codex",
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh" },
};
const standardModel = { id: "minimax/minimax-m2.7", provider: "openrouter", reasoning: true };
const plainModel = { id: "plain-model", provider: "local", reasoning: false };

function createHarness(options: { model?: any; thinkingLevel?: PiThinkingLevel; flags?: Record<string, string | boolean> } = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), "effort-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const runtime = createRuntimeRegistries();
  const { commands, events, shortcuts } = runtime;
  const flags = new Map<string, any>(Object.entries(options.flags ?? {}));
  const registeredFlags = new Map<string, any>();
  let thinkingLevel = options.thinkingLevel ?? "medium";

  const pi = {
    ...runtime.pi,
    registerFlag(name: string, flag: any) {
      registeredFlags.set(name, flag);
    },
    getFlag(name: string) {
      return flags.get(name);
    },
    getThinkingLevel() {
      return thinkingLevel;
    },
    setThinkingLevel(level: PiThinkingLevel) {
      thinkingLevel = level;
    },
  };

  effortExtension(pi as any);

  const notifications: Array<{ message: string; type: string }> = [];
  const status = new Map<string, string | undefined>();
  let workingMessage: string | undefined;
  let idle = true;
  let model = options.model ?? xhighModel;

  const ctx = {
    get model() {
      return model;
    },
    set model(next: any) {
      model = next;
    },
    isIdle: () => idle,
    ui: {
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
      setStatus(key: string, value: string | undefined) {
        status.set(key, value);
      },
      setWorkingMessage(value?: string) {
        workingMessage = value;
      },
    },
  };

  async function emit(name: string, event: any = {}) {
    for (const handler of events.get(name) ?? []) {
      await handler(event, ctx);
    }
  }

  function cleanup() {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  }

  return {
    agentDir,
    commands,
    events,
    shortcuts,
    registeredFlags,
    notifications,
    status,
    get workingMessage() {
      return workingMessage;
    },
    get thinkingLevel() {
      return thinkingLevel;
    },
    set thinkingLevel(next: PiThinkingLevel) {
      thinkingLevel = next;
    },
    set idle(next: boolean) {
      idle = next;
    },
    ctx,
    emit,
    cleanup,
  };
}

test("runtime registers effort command, flag, and shortcut", () => {
  const h = createHarness();
  try {
    assert.ok(h.commands.has("effort"));
    assert.ok(h.registeredFlags.has("effort"));
    assert.ok(h.shortcuts.has("ctrl+shift+e"));
  } finally {
    h.cleanup();
  }
});

test("runtime /effort command changes thinking level", async () => {
  const h = createHarness({ model: standardModel, thinkingLevel: "medium" });
  try {
    await h.emit("session_start");
    await h.commands.get("effort").handler("high", h.ctx);
    assert.equal(h.thinkingLevel, "high");
    assert.equal(h.status.get("effort-thinking"), "think:high");
  } finally {
    h.cleanup();
  }
});

test("runtime rejects unsupported xhigh without changing thinking level", async () => {
  const h = createHarness({ model: standardModel, thinkingLevel: "medium" });
  try {
    await h.emit("session_start");
    await h.commands.get("effort").handler("xhigh", h.ctx);
    assert.equal(h.thinkingLevel, "medium");
    assert.match(h.notifications.at(-1)?.message ?? "", /does not support xhigh/);
  } finally {
    h.cleanup();
  }
});

test("runtime --effort flag resolves aliases on session start", async () => {
  const h = createHarness({ model: xhighModel, thinkingLevel: "medium", flags: { effort: "max" } });
  try {
    await h.emit("session_start");
    assert.equal(h.thinkingLevel, "xhigh");
    assert.equal(h.status.get("effort-thinking"), "think:xhigh");
  } finally {
    h.cleanup();
  }
});

test("runtime completions expose only effort levels and fast on/off", async () => {
  const h = createHarness({ model: standardModel, thinkingLevel: "medium" });
  try {
    await h.emit("session_start");

    const effortOptions = await h.commands.get("effort").getArgumentCompletions("");
    assert.deepEqual(effortOptions.map((item: any) => item.value), ["min", "minimal", "low", "medium", "high", "max"]);
    assert.equal(await h.commands.get("effort").getArgumentCompletions("default "), null);

    const fastOptions = await h.commands.get("fast").getArgumentCompletions("");
    assert.deepEqual(fastOptions.map((item: any) => item.value), ["on", "off"]);
  } finally {
    h.cleanup();
  }
});

test("runtime /fast persists mode and injects OpenAI priority service tier", async () => {
  const h = createHarness({ model: xhighModel, thinkingLevel: "medium" });
  try {
    await h.emit("session_start");
    await h.commands.get("fast").handler("on", h.ctx);

    const persisted = JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf-8"));
    assert.equal(persisted.effort.fastMode, true);
    assert.equal(h.status.get("effort-fast"), "fast");

    const providerHandler = h.events.get("before_provider_request")?.[0];
    assert.ok(providerHandler);
    const payload = { model: "gpt-5.5", input: [], stream: true };
    const result = await providerHandler({ type: "before_provider_request", payload }, h.ctx);
    assert.deepEqual(result, { ...payload, service_tier: "priority" });
  } finally {
    h.cleanup();
  }
});

test("runtime /fast toggles and preserves explicit service tiers", async () => {
  const h = createHarness({ model: xhighModel, thinkingLevel: "medium" });
  try {
    await h.emit("session_start");
    await h.commands.get("fast").handler("", h.ctx);
    let persisted = JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf-8"));
    assert.equal(persisted.effort.fastMode, true);

    const providerHandler = h.events.get("before_provider_request")?.[0];
    assert.ok(providerHandler);
    assert.equal(await providerHandler({ payload: { model: "gpt-5.5", service_tier: "default" } }, h.ctx), undefined);

    await h.commands.get("fast").handler("", h.ctx);
    persisted = JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf-8"));
    assert.equal(persisted.effort.fastMode, false);
  } finally {
    h.cleanup();
  }
});

test("runtime model selection reflects Pi-clamped thinking state", async () => {
  const h = createHarness({ model: xhighModel, thinkingLevel: "xhigh" });
  try {
    await h.emit("session_start");
    await h.commands.get("fast").handler("on", h.ctx);

    h.ctx.model = standardModel;
    h.thinkingLevel = "high"; // Pi clamps before emitting model_select; the extension mirrors that state.
    await h.emit("model_select", { model: standardModel, previousModel: xhighModel, source: "set" });

    assert.equal(h.status.get("effort-thinking"), "think:high");
    assert.equal(h.status.get("effort-fast"), undefined);
  } finally {
    h.cleanup();
  }
});

test("runtime status keeps active run effort until agent ends", async () => {
  const h = createHarness({ model: xhighModel, thinkingLevel: "high" });
  try {
    await h.emit("session_start");
    h.idle = false;
    await h.emit("agent_start");
    h.thinkingLevel = "minimal";
    await h.emit("thinking_level_select", { level: "minimal", previousLevel: "high" });
    assert.equal(h.status.get("effort-thinking"), "think:high");

    h.idle = true;
    await h.emit("agent_end");
    assert.equal(h.status.get("effort-thinking"), "think:minimal");
  } finally {
    h.cleanup();
  }
});

test("runtime shortcut warns when thinking is unavailable", async () => {
  const h = createHarness({ model: plainModel, thinkingLevel: "off" });
  try {
    await h.emit("session_start");
    await h.shortcuts.get("ctrl+shift+e").handler(h.ctx);
    assert.equal(h.thinkingLevel, "off");
    assert.match(h.notifications.at(-1)?.message ?? "", /Thinking not available/);
  } finally {
    h.cleanup();
  }
});
