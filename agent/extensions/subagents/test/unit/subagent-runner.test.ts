import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

describe("async subagent runner bootstrap", () => {
	it("imports all control helpers used during startup", () => {
		const source = fs.readFileSync(path.join(root, "src/runs/background/subagent-runner.ts"), "utf-8");
		const importBlock = source.match(/import \{[\s\S]*?\} from "\.\.\/shared\/subagent-control\.ts";/)?.[0] ?? "";

		assert.match(importBlock, /DEFAULT_CONTROL_CONFIG/);
		assert.match(importBlock, /buildControlEvent/);
		assert.match(importBlock, /deriveActivityState/);
	});
});
