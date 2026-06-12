import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRtkArgumentCompletions } from "./command-completions.js";
import type { RtkIntegrationController } from "./types.js";
import { handleRtkIntegrationCommand } from "./config-modal.js";

export type { RtkIntegrationController } from "./types.js";

export function registerRtkIntegrationCommand(pi: ExtensionAPI, controller: RtkIntegrationController): void {
	pi.registerCommand("rtk", {
		description: "Configure RTK rewrite and output compaction integration",
		getArgumentCompletions: getRtkArgumentCompletions,
		handler: (args, ctx) => handleRtkIntegrationCommand(args, ctx, controller),
	});
}
