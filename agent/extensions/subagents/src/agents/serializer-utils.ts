import { frontmatterNameForConfig } from "./identity.ts";

export interface SerializableNamedConfig {
	localName?: string;
	packageName?: string;
	name: string;
	description: string;
}

export function joinComma(values: string[] | undefined): string | undefined {
	if (!values || values.length === 0) return undefined;
	return values.join(", ");
}

export function appendFrontmatterHeader(lines: string[], config: SerializableNamedConfig): void {
	lines.push("---");
	lines.push(`name: ${frontmatterNameForConfig(config)}`);
	if (config.packageName) lines.push(`package: ${config.packageName}`);
	lines.push(`description: ${config.description}`);
}
