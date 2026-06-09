# Render Progress Model Specification

## Requirements

### Requirement: Foreground Run View Derives a Structured Model Before Drawing

The subagents foreground result view SHALL derive its run-state — header/step counts, item
title, step spans, active-parallel-group window, and per-row label and status — into a
structured model produced by a pure function, and the renderer SHALL draw that model rather
than compute run-state inline.

#### Scenario: Parallel run counts come from the model

- WHEN a parallel foreground run with three agents and none completed is rendered
- THEN the derived model reports three total, zero done, and the running count
- AND the rendered header reflects the model's counts (e.g. "3 agents running · 0/3 done")

#### Scenario: Chain step progress comes from the model

- WHEN a chain foreground run is rendered
- THEN the model reports the logical step spans and the current/done step counts
- AND the renderer draws those without re-deriving them

#### Scenario: Derivation is unit-testable without drawing

- WHEN the foreground run model is derived from a `Details` fixture
- THEN the counts, per-row status, spans, and active-group window are assertable as data
- AND no rendered string is required to verify them

### Requirement: Single Flat-Index-to-Step Span Mapping

The mapping from a flat result index to its logical chain step or parallel group SHALL be
produced by one shared span builder used by both the foreground and async views; no view SHALL
re-implement span construction.

#### Scenario: Foreground and async views share the span builder

- WHEN spans are needed for a foreground `Details` run or an async `AsyncJobState` run
- THEN both obtain `ChainStepSpan[]` from the one shared builder
- AND a parallel group occupies a single step index spanning its agent count

### Requirement: Single Result-Status Precedence

The precedence that decides whether a result is completed, running, pending, failed, or
detached SHALL be defined once alongside the async step-status aggregation, and the foreground
view SHALL use it instead of a private copy.

#### Scenario: Foreground row status uses the shared precedence

- WHEN a foreground result has an explicit progress status, or is interrupted/detached, or has
  an exit code
- THEN its row status is determined by the shared precedence
- AND the same precedence vocabulary backs the async per-step aggregation

### Requirement: Behavior-Preserving Extraction

The change SHALL NOT alter rendered output. Existing render tests SHALL pass unchanged.

#### Scenario: Existing render string tests pass

- WHEN the foreground and widget render suites run after the extraction
- THEN every existing string assertion still matches
- AND no glyph, theme, or truncation behavior changes

