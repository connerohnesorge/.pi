# otel

OpenTelemetry traces and metrics for pi coding-agent sessions.

This package is a first-party version of the community `pi-otel-telemetry` idea, adapted for this workspace and the current `@earendil-works/pi-coding-agent` extension API.

## Installation

From this workspace:

```bash
cd otel
npm install
cd ..
pi install ./otel
```

If the package is published later, install it with `pi install npm:otel` (or the final package name). For local development, keep the `otel/` directory under `~/.pi/agent/extensions/` and run `/reload` after edits.

## Configuration

| Environment variable | Default | Description |
| --- | --- | --- |
| `PI_OTEL_ENABLED` | `true` | Set to `false` to disable all telemetry setup. |
| `PI_OTEL_DEBUG` | `false` | Set to `true` to add console trace/metric exporters and a small TUI status. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Base OTLP endpoint. HTTP signal paths are appended automatically; gRPC uses the base endpoint as-is. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | derived | Explicit OTLP trace endpoint. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | derived | Explicit OTLP metric endpoint. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | Set to `grpc` to match Claude Code's native OTLP setup. |
| `OTEL_EXPORTER_OTLP_HEADERS` | unset | Comma-separated OTLP headers, e.g. `Authorization=Bearer%20...`. |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | unset | Trace-specific headers merged over common headers. |
| `OTEL_EXPORTER_OTLP_METRICS_HEADERS` | unset | Metric-specific headers merged over common headers. |
| `PI_OTEL_CNB_AUTH` | `auto` | `auto` gets `cnb auth token` for `*.cnb.rocks` OTLP endpoints when no Authorization header exists. Set `false` to disable or `true` to force. |
| `PI_OTEL_CLAUDE_DASHBOARD_COMPAT` | `true` | Emit `claude_code_*` metric aliases (`token_usage_tokens`, `session_count`, `active_time_seconds`) so pi usage appears on the existing Claude Code Team Adoption dashboard. Set `false` to disable. |
| `OTEL_SERVICE_NAME` | `pi-coding-agent` | OpenTelemetry service name, unless overridden by `OTEL_RESOURCE_ATTRIBUTES`. |
| `OTEL_METRIC_EXPORT_INTERVAL` | `10000` | Metric export interval in milliseconds. |
| `OTEL_RESOURCE_ATTRIBUTES` | unset | Comma-separated resource attributes merged into the default resource. |
| `PI_OTEL_USER_EMAIL` | `git config --global user.email` | User email override. |
| `PI_OTEL_USER_NAME` | `git config --global user.name` | User display-name override. |

## Trace shape

```text
session
├── agent.prompt
│   └── agent.turn
│       ├── llm.request event
│       ├── tool.bash
│       ├── tool.read
│       └── tool.edit
├── model.changed event
└── session.compacted event
```

## Metrics

| Metric | Type | Attributes | Description |
| --- | --- | --- | --- |
| `pi.tokens.input` | Counter | common | Input + cache tokens consumed. |
| `pi.tokens.output` | Counter | common | Output tokens produced. |
| `pi.tool.calls` | Counter | `tool.name`, common | Tool invocation count. |
| `pi.tool.errors` | Counter | `tool.name`, common | Failed tool invocation count. |
| `pi.tool.duration` | Histogram, ms | `tool.name`, common | Tool execution duration. |
| `pi.turns` | Counter | common | LLM turn count. |
| `pi.prompts` | Counter | common | User prompt / agent-start count. |
| `pi.session.duration` | Histogram, s | common | Session lifetime. |

Common metric attributes are intentionally bounded: `user.name`, `user.email` when known, `environment`, `deployment.environment`, and `host.name`.

## Native reporting beside Claude Code

Your shell already exports the Claude Code collector settings:

```bash
export OTEL_EXPORTER_OTLP_PROTOCOL="grpc"
export OTEL_EXPORTER_OTLP_ENDPOINT="https://otlp.lan.cnb.rocks:443"
export OTEL_METRIC_EXPORT_INTERVAL="60000"
export OTEL_RESOURCE_ATTRIBUTES="service.namespace=claude-code,service.name=cohnesor,deployment.environment=workstation,host.name=$(hostname -s)"
```

With this extension loaded, pi honors those same variables. Because your `claude()` shell function only injects `OTEL_EXPORTER_OTLP_HEADERS` for the Claude process, this extension also has a `*.cnb.rocks` fallback: when no Authorization header is present, it runs `cnb auth token` and sends `Authorization: Bearer <token>` to the OTLP exporter. Disable that fallback with `PI_OTEL_CNB_AUTH=false`.

The extension also emits Claude Code dashboard-compatible metric aliases by default:

- `claude_code_token_usage_tokens_total` with `type=input|output|cacheRead|cacheCreation`, dashboard-style `model` (model id/name only, no provider prefix), `project_name`, and `query_source=main`
- `claude_code_session_count_total`
- `claude_code_active_time_seconds_total`

Those aliases are what the current `Claude Code — Team Adoption` dashboard queries. The extension primes them with a zero sample on session start so even short `pi -p` sessions produce positive Prometheus `increase()` values after their final flush. Disable them with `PI_OTEL_CLAUDE_DASHBOARD_COMPAT=false` if you only want the native `pi_*` metrics.

## Local collector quick start

```bash
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/jaeger:2 \
  --set receivers.otlp.protocols.http.endpoint=0.0.0.0:4318

PI_OTEL_DEBUG=true pi
open http://localhost:16686
```

## Differences from upstream reference

- Uses `@earendil-works/pi-coding-agent` instead of the legacy `@mariozechner` namespace.
- Uses package conventions from this extension workspace.
- Supports both OTLP HTTP/protobuf and Claude-style OTLP gRPC endpoints.
- Adds an optional cnb bearer-token fallback for athens `*.cnb.rocks` collectors.
- Emits Claude Code dashboard-compatible metric aliases so pi usage appears on the existing team dashboard using the same model-label and `query_source` conventions as Claude Code.
- Keeps helper logic exported and covered by Vitest.
- Does not include a bundled Grafana dashboard yet; this package focuses on the extension, emitted telemetry, and documentation.
