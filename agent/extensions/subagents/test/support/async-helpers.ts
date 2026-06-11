// fallow-ignore-file code-duplication
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "./mock-pi.ts";

export const DISABLED_ARTIFACT_CONFIG = {
	enabled: false,
	includeInput: false,
	includeOutput: false,
	includeJsonl: false,
	includeMetadata: false,
	cleanupDays: 7,
};

export function makeAsyncCtx(cwd: string, overrides: Record<string, unknown> = {}) {
	return {
		pi: { events: { emit() {} } },
		cwd,
		currentSessionId: "session-1",
		...overrides,
	};
}

export function makeAsyncSingleParams(tempDir: string, overrides: Record<string, unknown> = {}) {
	return {
		agent: "worker",
		task: "Do work",
		agentConfig: undefined,
		ctx: makeAsyncCtx(tempDir),
		artifactConfig: DISABLED_ARTIFACT_CONFIG,
		shareEnabled: false,
		sessionRoot: path.join(tempDir, "sessions"),
		maxSubagentDepth: 2,
		...overrides,
	};
}

export async function waitForFile(
	filePath: string,
	options: { timeoutMs?: number; intervalMs?: number; describe?: string } = {},
): Promise<string> {
	const timeoutMs = options.timeoutMs ?? 15_000;
	const intervalMs = options.intervalMs ?? 50;
	const deadline = Date.now() + timeoutMs;
	while (!fs.existsSync(filePath)) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${options.describe ?? filePath}`);
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	return filePath;
}

export function readJsonFile<T>(filePath: string): T {
	return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

export async function waitForJsonFile<T>(filePath: string, options?: { timeoutMs?: number; intervalMs?: number; describe?: string }): Promise<T> {
	await waitForFile(filePath, options);
	return readJsonFile<T>(filePath);
}

export function readMockPiArgs(mockPi: MockPi, index: number | "last" = "last"): string[] {
	const callFiles = fs.readdirSync(mockPi.dir)
		.filter((name) => name.startsWith("call-") && name.endsWith(".json"))
		.sort();
	const callFile = index === "last" ? callFiles.at(-1) : callFiles[index];
	if (!callFile) throw new Error(`Expected recorded mock pi call at index ${String(index)}`);
	return readJsonFile<{ args: string[] }>(path.join(mockPi.dir, callFile)).args;
}

export function writePackageSkill(packageRoot: string, skillName: string): void {
	const skillDir = path.join(packageRoot, "skills", skillName);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(packageRoot, "package.json"),
		JSON.stringify({ name: `${skillName}-pkg`, version: "1.0.0", pi: { skills: [`./skills/${skillName}`] } }, null, 2),
		"utf-8",
	);
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${skillName}\ndescription: test skill\n---\nbody\n`,
		"utf-8",
	);
}
