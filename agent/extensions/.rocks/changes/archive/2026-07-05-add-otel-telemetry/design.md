## Implementation Details

Create `otel/` as an npm/pi package with `pi.extensions: ["./index.ts"]`, `type: "module"`, TypeScript tests, and runtime OpenTelemetry dependencies.

The extension factory will return early when `PI_OTEL_ENABLED=false`. Otherwise it will:

- resolve OTLP traces and metrics endpoints from per-signal overrides or `OTEL_EXPORTER_OTLP_ENDPOINT`, appending `/v1/traces` or `/v1/metrics` only for HTTP/protobuf exports and preserving the base endpoint for `OTEL_EXPORTER_OTLP_PROTOCOL=grpc`;
- resolve user identity from `PI_OTEL_USER_EMAIL`, `PI_OTEL_USER_NAME`, git config, OS username, and hostname;
- parse OTLP header environment variables and, for athens `*.cnb.rocks` endpoints without an Authorization header, obtain a bearer token via `cnb auth token` unless disabled;
- create a local `NodeTracerProvider` and `MeterProvider` using a shared resource instead of registering a global tracer provider;
- create counters/histograms for prompts, turns, tokens, tool calls/errors/duration, and session duration;
- maintain in-memory span state for the current session, current agent prompt, current turn, and concurrently-running tools;
- end/flush/shutdown providers on `session_shutdown`, swallowing exporter failures after optionally notifying/logging.

Pure helpers such as endpoint resolution, resource attribute parsing, argument summarization, and identity resolution seams should be exported for Vitest coverage without loading pi.

## Context

The reference project `mprokopov/pi-otel-telemetry` demonstrates the desired trace/metric shape, but imports an older package namespace and is not arranged like our extension packages. Our version should use the workspace's package conventions and avoid copying hidden Git state or unrelated artifacts.

## Goals / Non-Goals

- Goals: local first-party `otel` package, current pi SDK imports, reload-safe telemetry providers, Claude-compatible native OTLP gRPC reporting, documented configuration, helper tests.
- Non-Goals: dashboards beyond a minimal README pointer, custom TUI visualizations, tracing subagent internals beyond the emitted pi lifecycle events, or changing any existing extension package.

## Decisions

- Decision: use provider instances directly instead of `traceProvider.register()` so `/reload` can instantiate a fresh extension without relying on process-global OpenTelemetry state.
- Decision: keep user/host identity as resource attributes and repeat only a small stable subset on metrics to support Grafana filtering without high-cardinality labels.
- Decision: use `Date.now()` through a small injectable seam in tests where duration logic needs determinism.

## Risks / Trade-offs

- OTLP exporter package versions can drift across OpenTelemetry major lines. Mitigation: pin compatible versions in `otel/package.json` and run `npm install` in `otel/` to lock them.
- Exporter shutdown may fail when collectors are absent. Mitigation: catch and report errors without breaking pi.
- Tool arguments can contain large or sensitive data. Mitigation: store only truncated summaries in trace attributes.

## Migration Plan

No migration is required. Users can load the extension via `pi install` from this package or by auto-discovery from `./otel` after dependencies are installed.

## Open Questions

- Should we import or adapt the reference Grafana dashboard later, or keep this change focused on the extension package and documentation?
