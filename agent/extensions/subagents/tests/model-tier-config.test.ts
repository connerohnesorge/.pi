import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

async function loadModule() {
  return await import("../src/model-tier-config.ts");
}

describe("model-tier-config", () => {
  describe("buildDefaultTierConfig", () => {
    it("defaults every standard tier to GPT-5.5 with increasing reasoning levels", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      assert.deepEqual(buildDefaultTierConfig("ignored", ["ignored/model"]).tiers, {
        small: "openai-codex/gpt-5.5:low",
        medium: "openai-codex/gpt-5.5:medium",
        big: "openai-codex/gpt-5.5:high",
      });
    });

    it("returns a fresh copy", async () => {
      const { buildDefaultTierConfig } = await loadModule();
      const a = buildDefaultTierConfig();
      const b = buildDefaultTierConfig();
      a.tiers.small = "changed";
      assert.equal(b.tiers.small, "openai-codex/gpt-5.5:low");
    });
  });

  describe("resolveTierModel", () => {
    it("returns the model for a valid tier", async () => {
      const { resolveTierModel } = await loadModule();
      const config = { tiers: { small: "a", medium: "b", big: "c" } };
      assert.equal(resolveTierModel("small", config), "a");
      assert.equal(resolveTierModel("medium", config), "b");
      assert.equal(resolveTierModel("big", config), "c");
    });

    it("returns undefined for unknown tier name", async () => {
      const { resolveTierModel } = await loadModule();
      assert.equal(resolveTierModel("missing", { tiers: { small: "a" } }), undefined);
    });
  });

  describe("loadModelTierConfig / saveModelTierConfig", () => {
    it("round-trips a valid config through disk", async () => {
      const { loadModelTierConfig, saveModelTierConfig } = await loadModule();
      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      const config = { tiers: { small: "gpt:low", medium: "gpt:medium", big: "gpt:high" } };
      saveModelTierConfig(config, cfgPath);
      assert.deepEqual(loadModelTierConfig(cfgPath), config);
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null for missing or invalid configs", async () => {
      const { loadModelTierConfig } = await loadModule();
      assert.equal(loadModelTierConfig(join(tmpdir(), "missing-model-tiers.json")), null);

      const tmpDir = mkdtempSync(join(tmpdir(), "mtc-test-"));
      const cfgPath = join(tmpDir, "model-tiers.json");
      for (const raw of ["{bad", '"string"', '{"tiers":"bad"}', '{"tiers":{"small":["bad"]}}']) {
        writeFileSync(cfgPath, raw, "utf-8");
        assert.equal(loadModelTierConfig(cfgPath), null);
      }
      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  describe("sortedTierNames", () => {
    it("sorts standard tiers before custom names", async () => {
      const { sortedTierNames } = await loadModule();
      assert.deepEqual(sortedTierNames({ tiers: { xlarge: "x", big: "b", small: "s", medium: "m" } }), [
        "small",
        "medium",
        "big",
        "xlarge",
      ]);
    });
  });
});
