# Intercom Bridge Specification

## Requirements

### Requirement: Single Intercom Activation Gate

The subagents extension SHALL evaluate whether the intercom bridge is active through one
shared gate evaluator that resolves the bridge mode, extension directory, orchestrator target,
and config status, and applies the activation gates in a fixed order. Both runtime resolution
and doctor diagnostics SHALL derive their activation result from this one evaluator.

#### Scenario: Runtime resolution and diagnostics agree on activation

- WHEN the same inputs are passed to runtime resolution and to doctor diagnostics
- THEN both report the same `active` outcome
- AND both derive it from the one shared gate evaluator rather than independent gate ladders

#### Scenario: Gate order is fixed

- WHEN the bridge is evaluated
- THEN the gates are checked in order: mode off, fork-only outside a fork, missing orchestrator
  target, missing pi-intercom extension, disabled intercom config
- AND the first failing gate determines the inactive reason

### Requirement: Runtime Resolution Builds Instructions; Diagnostics Reports Reasons

Runtime resolution SHALL, on an active decision, build the bridge instruction (template read
and orchestrator substitution); doctor diagnostics SHALL, on any decision, report the failing
reason and diagnostic fields. Runtime resolution SHALL NOT be implemented as an adapter over
the diagnostics function.

#### Scenario: Active runtime resolution returns an instruction

- WHEN the gate evaluator reports active
- THEN runtime resolution returns an active state carrying the built bridge instruction and the
  orchestrator target

#### Scenario: Inactive resolution returns the default instruction

- WHEN the gate evaluator reports inactive
- THEN runtime resolution returns an inactive state with the default instruction
- AND it does not read the instruction-template file

#### Scenario: Diagnostics reports the inactive reason

- WHEN the gate evaluator reports inactive with a reason
- THEN doctor diagnostics surfaces that reason and the resolved diagnostic fields
- AND it does not build or return a bridge instruction

