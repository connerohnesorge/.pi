import { normalizeSkillInput } from "../../agents/skills.ts";
import type { StepOverrides } from "../../shared/settings.ts";
import { normalizeSingleOutputOverride } from "./single-output.ts";

/**
 * The wire/parse shape carried across the override boundary.
 *
 * `TaskParam` (tool JSON input) and `InlineConfig` (slash tokens) both model
 * untrusted input with `string | boolean` sentinels and a singular `skill`.
 * `normalizeOverrideInput` decodes that into the resolved `StepOverrides`
 * (`string | false`, plural `skills`).
 */
export interface OverrideInput {
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	reads?: string[] | boolean;
	progress?: boolean;
	skill?: string | string[] | boolean;
	model?: string;
}

/**
 * Reads decode: a boolean `true` defers to the agent default (omitted), an
 * explicit `false` disables reads, and an array passes through. Mirrors the
 * per-site `reads !== undefined && reads !== true` rule.
 */
function normalizeReadsInput(reads: string[] | boolean | undefined): string[] | false | undefined {
	if (reads === undefined || reads === true) return undefined;
	if (reads === false) return false;
	return reads;
}

/**
 * Decode raw override input into the resolved {@link StepOverrides} shape.
 *
 * This is the single home for the wire→resolved override decode:
 * - `output`: delegates to {@link normalizeSingleOutputOverride}
 *   (`false`/`"false"`→`false`, `true`/`"true"`→agent default, path→path).
 * - `reads`: boolean defers/disables, array passthrough.
 * - `skill`→`skills`: singular input normalized to the plural resolved field.
 * - `outputMode`/`progress`/`model`: passthrough.
 *
 * Fields that decode to `undefined` are omitted so resolution can fall back to
 * agent frontmatter defaults.
 */
export function normalizeOverrideInput(input: OverrideInput, agentDefaultOutput?: string): StepOverrides {
	const overrides: StepOverrides = {};

	const output = normalizeSingleOutputOverride(input.output, agentDefaultOutput);
	if (output !== undefined) overrides.output = output;

	if (input.outputMode !== undefined) overrides.outputMode = input.outputMode;

	const reads = normalizeReadsInput(input.reads);
	if (reads !== undefined) overrides.reads = reads;

	if (input.progress !== undefined) overrides.progress = input.progress;

	const skills = normalizeSkillInput(input.skill);
	if (skills !== undefined) overrides.skills = skills;

	if (input.model !== undefined) overrides.model = input.model;

	return overrides;
}
