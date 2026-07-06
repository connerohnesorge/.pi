## 1. Implementation

- [ ] 1.1 Create `otel/package.json`, lockfile, README, gitignore, and TypeScript/Vitest configuration using this workspace's package conventions.
- [ ] 1.2 Implement the `otel/index.ts` extension with reload-safe trace and metric providers, env configuration, identity/resource attributes, lifecycle spans, tool spans, token metrics, model/compaction/provider events, and safe shutdown.
- [ ] 1.3 Extract and export pure helper functions for endpoint resolution, resource-attribute parsing, argument summarization, string truncation, and identity resolution seams.
- [ ] 1.4 Add Vitest coverage for helpers and edge cases that do not require a live pi runtime.
- [ ] 1.5 Run package checks/tests and fix issues.

## 2. Documentation

- [ ] 2.1 Document installation, environment variables, emitted traces/metrics, debug mode, and known differences from the upstream reference.
