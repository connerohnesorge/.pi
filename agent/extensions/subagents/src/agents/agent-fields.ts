/**
 * Single agent-field schema.
 *
 * One descriptor table is the source of truth for "what an agent field is":
 * its canonical {@link AgentConfig} key, its frontmatter key(s) (including the
 * `skill`/`skills` alias), and its kind. The frontmatter decoder, the JSON
 * config decoder, and the serializer all consult this table instead of keeping
 * three hand-maintained copies of the field list. Nothing here performs I/O.
 */

import type { AgentConfig } from "./agents.ts";

/** Kind of an agent field, describing how its frontmatter value is shaped. */
export type AgentFieldKind = "scalar" | "csv" | "bool" | "enum";

/** One row per agent field — the single source of truth for "what an agent field is". */
export interface AgentFieldDescriptor {
	/** Canonical {@link AgentConfig} key. */
	config: keyof AgentConfig;
	/** Frontmatter key(s); e.g. ["skill", "skills"] — the alias lives here, once. */
	frontmatterKeys: string[];
	/** How the frontmatter value is shaped. */
	kind: AgentFieldKind;
	/** Allowed values for kind === "enum" (e.g. systemPromptMode). */
	enumValues?: readonly string[];
}

/**
 * The agent-field schema. Defaults stay per-surface (several depend on the
 * agent's localName), so they are not encoded here.
 */
export const AGENT_FIELDS: readonly AgentFieldDescriptor[] = [
	{ config: "name", frontmatterKeys: ["name"], kind: "scalar" },
	{ config: "packageName", frontmatterKeys: ["package"], kind: "scalar" },
	{ config: "description", frontmatterKeys: ["description"], kind: "scalar" },
	{ config: "tools", frontmatterKeys: ["tools"], kind: "csv" },
	{ config: "model", frontmatterKeys: ["model"], kind: "scalar" },
	{ config: "fallbackModels", frontmatterKeys: ["fallbackModels"], kind: "csv" },
	{ config: "thinking", frontmatterKeys: ["thinking"], kind: "scalar" },
	{ config: "systemPromptMode", frontmatterKeys: ["systemPromptMode"], kind: "enum", enumValues: ["append", "replace"] },
	{ config: "inheritProjectContext", frontmatterKeys: ["inheritProjectContext"], kind: "bool" },
	{ config: "inheritSkills", frontmatterKeys: ["inheritSkills"], kind: "bool" },
	{ config: "defaultContext", frontmatterKeys: ["defaultContext"], kind: "enum", enumValues: ["fresh", "fork"] },
	{ config: "skills", frontmatterKeys: ["skill", "skills"], kind: "csv" },
	{ config: "extensions", frontmatterKeys: ["extensions"], kind: "csv" },
	{ config: "output", frontmatterKeys: ["output"], kind: "scalar" },
	{ config: "defaultReads", frontmatterKeys: ["defaultReads"], kind: "csv" },
	{ config: "defaultProgress", frontmatterKeys: ["defaultProgress"], kind: "bool" },
	{ config: "interactive", frontmatterKeys: ["interactive"], kind: "bool" },
	{ config: "maxSubagentDepth", frontmatterKeys: ["maxSubagentDepth"], kind: "scalar" },
	{ config: "completionGuard", frontmatterKeys: ["completionGuard"], kind: "bool" },
];

/**
 * The set of every known frontmatter key, derived from {@link AGENT_FIELDS}.
 * Replaces the hand-kept set that previously lived in agent-serializer.ts.
 * Unknown frontmatter keys (those not in this set) become `extraFields`.
 */
export const KNOWN_FIELDS: ReadonlySet<string> = new Set(
	AGENT_FIELDS.flatMap((field) => field.frontmatterKeys),
);

/**
 * The one tool-list codec: split a raw tool list into plain `tools` and
 * `mcp:`-prefixed `mcpDirectTools`. The direct name is trimmed and empties are
 * dropped (a safe superset, since every call site pre-trims its tokens).
 * Replaces the three former copies (splitToolList, the inline frontmatter loop,
 * and parseTools).
 */
export function splitToolList(rawTools: string[] | undefined): { tools?: string[]; mcpDirectTools?: string[] } {
	const tools: string[] = [];
	const mcpDirectTools: string[] = [];
	for (const tool of rawTools ?? []) {
		if (tool.startsWith("mcp:")) {
			const direct = tool.slice(4).trim();
			if (direct) mcpDirectTools.push(direct);
		} else {
			tools.push(tool);
		}
	}
	return {
		...(tools.length > 0 ? { tools } : {}),
		...(mcpDirectTools.length > 0 ? { mcpDirectTools } : {}),
	};
}

/**
 * The inverse of {@link splitToolList}: join plain `tools` followed by
 * `mcp:`-prefixed `mcpDirectTools` back into a single list, or `undefined` when
 * empty.
 */
export function joinToolList(config: Pick<AgentConfig, "tools" | "mcpDirectTools">): string[] | undefined {
	const joined = [
		...(config.tools ?? []),
		...(config.mcpDirectTools ?? []).map((tool) => `mcp:${tool}`),
	];
	return joined.length > 0 ? joined : undefined;
}
