## ADDED Requirements

### Requirement: Pure Clarification State Model

The subagents extension SHALL keep chain clarification state transitions behind a pure model interface separate from the terminal rendering adapter.

#### Scenario: Editing task text without terminal rendering

- WHEN a test enters task editing through the clarification model and saves new text
- THEN the model updates the corresponding template without requiring a TUI component or rendered terminal rows

#### Scenario: Updating behavior overrides without terminal rendering

- WHEN a test changes output, reads, progress, model, thinking, or skills through the clarification model
- THEN the model returns the same behavior override result that the terminal adapter would submit

### Requirement: Terminal Adapter Compatibility

The subagents extension SHALL preserve the existing chain clarification terminal adapter constructor and rendered behavior while delegating state transitions to the pure model.

#### Scenario: Existing clarification callers continue to instantiate the component

- WHEN foreground single, parallel, or chain execution creates `ChainClarifyComponent` with the existing constructor arguments
- THEN the component renders and completes clarification with the same result shape as before
