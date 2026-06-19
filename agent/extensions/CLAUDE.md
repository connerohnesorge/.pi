<!-- rocks:start -->
# Rocks Instructions

These instructions are for AI assistants working in this project.

Always open `@.rocks/AGENTS.md` when the request:

- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big
  performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@.rocks/AGENTS.md` to learn:

- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Always open `@.rocks/CONTEXT.md` to learn the project's domain language,
key decisions, and shared context before planning or writing code.

When delegating tasks from a change proposal to subagents:

- Provide the proposal path: `.rocks/changes/<id>/proposal.md`
- Include task context: `.rocks/changes/<id>/tasks.jsonc`
- Reference delta specs: `.rocks/changes/<id>/specs/<capability>/spec.md`

<!-- rocks:end -->