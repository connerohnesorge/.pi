# Change: Add OpenTelemetry telemetry extension

## Why

We want a first-party `otel` pi extension in this workspace, based on the behavior of `mprokopov/pi-otel-telemetry` but adapted to our package conventions, current `@earendil-works` SDK imports, and reload-safe extension lifecycle.

## What Changes

- Add a new independent extension package under `./otel`.
- Export OpenTelemetry traces for sessions, agent prompts, turns, provider requests, tool executions, model changes, and compactions.
- Export metrics for prompt/turn/tool/token/session activity with stable, low-cardinality attributes, plus Claude Code dashboard-compatible aliases for the existing team dashboard.
- Support OTLP HTTP and Claude-style OTLP gRPC endpoint configuration, debug console export, user/host identity enrichment, cnb bearer-token fallback for athens collectors, and opt-out via environment variables.
- Include package metadata, README guidance, and tests for pure telemetry helpers.

## Impact

- Affected specs: `otel-telemetry` (new)
- Affected code: `otel/` package only
- External dependencies: OpenTelemetry JS packages for API, trace/metric SDKs, OTLP HTTP exporters, resources, and semantic conventions
