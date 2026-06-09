## ADDED Requirements

### Requirement: OTEL Extension Package

The workspace SHALL provide an independent pi package under `./otel` that loads a TypeScript extension entrypoint through package metadata and uses the current `@earendil-works/pi-coding-agent` SDK namespace.

#### Scenario: Package discovery

- WHEN the `otel` package is installed or discovered by pi
- THEN pi loads `otel/index.ts` as the extension entrypoint
- AND the package metadata identifies it as a pi extension package

#### Scenario: Current SDK namespace

- WHEN maintainers inspect the extension source
- THEN pi SDK imports reference `@earendil-works/pi-coding-agent`
- AND the source does not depend on the legacy `@mariozechner/pi-coding-agent` package namespace

### Requirement: Configurable OTLP Export

The extension SHALL configure OTLP HTTP trace and metric exporters from environment variables while allowing telemetry to be disabled.

#### Scenario: Default endpoints

- WHEN no OTEL endpoint environment variables are set
- THEN traces export to `http://localhost:4318/v1/traces`
- AND metrics export to `http://localhost:4318/v1/metrics`

#### Scenario: Base endpoint override

- WHEN `OTEL_EXPORTER_OTLP_ENDPOINT` is set to a base collector URL
- THEN the trace exporter appends `/v1/traces`
- AND the metric exporter appends `/v1/metrics`

#### Scenario: Per-signal endpoint override

- WHEN `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` are set
- THEN the corresponding exporter uses that per-signal endpoint
- AND an already signal-specific `/v1/traces` or `/v1/metrics` suffix is not duplicated

#### Scenario: Claude-style gRPC endpoint

- WHEN `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` and `OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.lan.cnb.rocks:443` are set like the user's Claude Code shell configuration
- THEN the extension uses OTLP gRPC exporters
- AND the gRPC exporter endpoint remains `https://otlp.lan.cnb.rocks:443` without appending HTTP `/v1/*` paths

#### Scenario: OTLP headers and cnb auth fallback

- WHEN `OTEL_EXPORTER_OTLP_HEADERS` or per-signal header variables are set
- THEN the extension passes those headers to the OTLP exporter
- AND when the endpoint is under `*.cnb.rocks` with no Authorization header
- THEN the extension obtains a `cnb auth token` bearer token unless `PI_OTEL_CNB_AUTH=false`

#### Scenario: Telemetry disabled

- WHEN `PI_OTEL_ENABLED=false`
- THEN the extension performs no OpenTelemetry provider or hook setup

### Requirement: Lifecycle Tracing

The extension SHALL emit a session root span with nested agent prompt spans, turn spans, tool execution spans, and LLM request events using pi lifecycle hooks.

#### Scenario: Session span lifecycle

- WHEN pi emits `session_start`
- THEN the extension starts a `session` span with session, cwd, identity, host, and service attributes
- AND when pi emits `session_shutdown`
- THEN the extension records session totals, ends the span, and flushes/shuts down telemetry providers without throwing exporter failures into pi

#### Scenario: Prompt and turn spans

- WHEN pi emits `agent_start` and `turn_start`
- THEN the extension starts `agent.prompt` and `agent.turn` spans under the current session context
- AND when `agent_end` and `turn_end` are emitted
- THEN the corresponding spans record counts/usage attributes and end with an OK status

#### Scenario: Tool span concurrency

- WHEN multiple tool executions are in flight
- THEN each `tool_execution_start` creates a span keyed by its `toolCallId`
- AND each `tool_execution_end` ends only the matching span with tool name, call id, duration, argument summary, and error status attributes

#### Scenario: Provider and session events

- WHEN pi emits `before_provider_request`, `model_select`, or `session_compact`
- THEN the extension records bounded span events or attributes on the active turn/session span

### Requirement: Metrics Export

The extension SHALL emit counters and histograms for prompt, turn, token, tool, and session activity with stable attributes.

#### Scenario: Activity counters

- WHEN prompts, turns, tool calls, or token usage occur
- THEN the extension increments `pi.prompts`, `pi.turns`, `pi.tool.calls`, `pi.tokens.input`, and `pi.tokens.output` as appropriate

#### Scenario: Tool and session measurements

- WHEN a tool execution ends
- THEN the extension records `pi.tool.duration` and increments `pi.tool.errors` for failed executions
- AND when the session shuts down
- THEN the extension records `pi.session.duration`

#### Scenario: Stable metric attributes

- WHEN metrics are recorded
- THEN common user/host/environment attributes are included only from a bounded, documented set
- AND Claude-style `deployment.environment` resource attributes may be included as a bounded common metric attribute
- AND tool metrics include `tool.name`

#### Scenario: Claude dashboard-compatible metric aliases

- WHEN pi sessions, turns, and token usage are recorded
- THEN the extension emits `claude_code_token_usage_tokens`, `claude_code_session_count`, and `claude_code_active_time_seconds` counter aliases by default
- AND the aliases include dashboard labels such as `user_email`, `model`, `project_name`, and token `type`
- AND setting `PI_OTEL_CLAUDE_DASHBOARD_COMPAT=false` disables those aliases without disabling native `pi_*` metrics

### Requirement: Identity and Argument Hygiene

The extension SHALL enrich telemetry with account identity while avoiding large argument payloads in trace attributes.

#### Scenario: Identity resolution

- WHEN identity environment variables are present
- THEN they take precedence over git config values
- AND OS username and hostname are included when available

#### Scenario: Truncated argument summaries

- WHEN a tool execution includes large or complex arguments
- THEN the trace attribute contains only a short summary capped to a documented length
- AND unserializable arguments produce a safe placeholder instead of throwing

### Requirement: Documentation and Tests

The `otel` package SHALL document its configuration and include tests for pure helper behavior.

#### Scenario: User documentation

- WHEN a user reads `otel/README.md`
- THEN they can identify installation steps, environment variables, emitted trace/metric names, debug mode, and differences from the upstream reference

#### Scenario: Helper tests

- WHEN maintainers run the `otel` package test script
- THEN endpoint resolution, resource attribute parsing, truncation, summarization, and identity fallback behavior are verified without requiring a live OTLP collector or pi runtime
