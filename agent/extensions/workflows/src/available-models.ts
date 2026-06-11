import { join } from "node:path";
import { AuthStorage, getAgentDir, ModelRegistry } from "@earendil-works/pi-coding-agent";

/**
 * List the user's currently available models (those with auth configured) as
 * `provider/modelId` specs. Used to tell workflow authors which models they may
 * route agents to. Best-effort: returns [] if the registry can't be built.
 */
export function listAvailableModelSpecs(): string[] {
  try {
    const dir = getAgentDir();
    const auth = AuthStorage.create(join(dir, "auth.json"));
    const registry = ModelRegistry.create(auth, join(dir, "models.json"));
    return registry.getAvailable().map((m) => `${m.provider}/${m.id}`);
  } catch {
    return [];
  }
}
