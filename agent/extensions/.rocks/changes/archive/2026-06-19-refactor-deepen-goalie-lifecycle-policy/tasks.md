## 1. Runtime modules

- [x] 1.1 Add shared auditor progress contract and update auditor/widget imports.
- [x] 1.2 Add pure goal tool policy module and tests.
- [x] 1.3 Add goal completion runtime module and tests.
- [x] 1.4 Add objective/tweak runtime module and tests.

## 2. Adapter integration

- [x] 2.1 Replace inline completion/archival logic in `goal.ts` with completion runtime calls.
- [x] 2.2 Remove complete-goal archival from generic `persist()`.
- [x] 2.3 Replace inline active-tool/tool-call/turn-end policy with the policy module.
- [x] 2.4 Replace inline objective/tweak write logic with objective runtime calls.
- [x] 2.5 Add `/goalie-tweak [hint]` to wire the existing prompt-driven tweak flow.

## 3. Verification

- [x] 3.1 Update unit tests to call runtime/policy modules directly instead of source-shape or storage-only replicas.
- [x] 3.2 Add E2E coverage for active-tool policy and `apply_goal_tweak` through the real extension path.
- [x] 3.3 Run `npm run check`, `npm test`, and `npm run test:e2e`.
