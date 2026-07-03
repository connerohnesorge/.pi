#!/usr/bin/env node

/** Install this packaged workflow extension into Pi's local extensions dir. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.join(os.homedir(), ".pi", "agent", "extensions", "subagents");

const args = process.argv.slice(2);
const isRemove = args.includes("--remove") || args.includes("-r");
const isHelp = args.includes("--help") || args.includes("-h");

if (isHelp) {
  console.log(`
pi-subagents - Pi dynamic workflows extension

Usage:
  npx pi-subagents          Install the extension
  npx pi-subagents --remove Remove the extension
  npx pi-subagents --help   Show this help

Installation directory: ${EXTENSION_DIR}
`);
  process.exit(0);
}

if (isRemove) {
  fs.rmSync(EXTENSION_DIR, { recursive: true, force: true });
  console.log("pi-subagents removed");
  process.exit(0);
}

if (path.resolve(PACKAGE_DIR) !== path.resolve(EXTENSION_DIR)) {
  fs.mkdirSync(path.dirname(EXTENSION_DIR), { recursive: true });
  fs.rmSync(EXTENSION_DIR, { recursive: true, force: true });
  fs.cpSync(PACKAGE_DIR, EXTENSION_DIR, {
    recursive: true,
    filter: (src) => !/[\\/]node_modules[\\/]|[\\/]\.git[\\/]/.test(src),
  });
}

console.log(`
Installed pi dynamic workflows at ${EXTENSION_DIR}

Tool added:
  • workflow - Run deterministic JavaScript workflows with isolated agents

Commands added:
  • /workflows, /workflows-models, /deep-research, /adversarial-review
  • /multi-perspective, /codebase-audit, /effort, /ultracode

Run /reload in Pi to load the extension.
`);
