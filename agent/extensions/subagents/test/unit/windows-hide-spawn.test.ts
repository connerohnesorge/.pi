import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readSource(sourcePath: string): string {
	return fs.readFileSync(path.join(projectRoot, sourcePath), "utf-8");
}

describe("nested child Pi process visibility", () => {
	it("hides nested child Pi process windows on Windows in the shared driver", () => {
		// The spawn lives in one shared driver; both execution paths route through it.
		assert.match(
			readSource("src/runs/shared/child-driver.ts"),
			/spawn\(spawnSpec\.command,\s*spawnSpec\.args,\s*\{[^}]*windowsHide:\s*true/s,
			"shared child driver spawn should set windowsHide: true",
		);
	});

	it("drives the foreground child through the shared driver", () => {
		assert.match(
			readSource("src/runs/foreground/execution.ts"),
			/driveChildProcess\(/,
			"foreground execution should spawn via the shared driver",
		);
	});

	it("drives the background child through the shared driver", () => {
		assert.match(
			readSource("src/runs/background/subagent-runner.ts"),
			/driveChildProcess\(/,
			"background runner should spawn via the shared driver",
		);
	});
});
