/**
 * OpenTelemetry traces and metrics for pi coding-agent sessions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Metadata } from "@grpc/grpc-js";
import { context, SpanStatusCode, trace, type Attributes, type Context, type Span, type Tracer } from "@opentelemetry/api";
import { OTLPMetricExporter as OTLPGrpcMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPMetricExporter as OTLPHttpMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter as OTLPGrpcTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as OTLPHttpTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ConsoleMetricExporter, MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, ConsoleSpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { execFileSync } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { basename } from "node:path";

const INSTRUMENTATION_NAME = "pi-otel-extension";
const INSTRUMENTATION_VERSION = "0.1.0";
const DEFAULT_OTLP_ENDPOINT = "http://localhost:4318";
const DEFAULT_SERVICE_NAME = "pi-coding-agent";
const DEFAULT_METRIC_EXPORT_INTERVAL_MS = 10_000;
const TOOL_ARG_SUMMARY_LIMIT = 200;

export type OtlpSignal = "traces" | "metrics";
export type OtlpProtocol = "grpc" | "http/protobuf";

export interface AccountIdentity {
	email: string;
	fullName: string;
	userName: string;
	hostName: string;
}

export interface AccountIdentityResolvers {
	gitConfig?: (key: string) => string;
	userName?: () => string;
	hostName?: () => string;
}

export interface OtlpHeaderResolvers {
	cnbAuthToken?: () => string;
}

interface ToolSpanEntry {
	span: Span;
	startTime: number;
}

export default function registerOtelTelemetry(pi: ExtensionAPI): void {
	if (process.env.PI_OTEL_ENABLED === "false") return;

	const debug = process.env.PI_OTEL_DEBUG === "true";
	const claudeDashboardCompat = process.env.PI_OTEL_CLAUDE_DASHBOARD_COMPAT !== "false";
	const protocol = resolveOtlpProtocol(process.env.OTEL_EXPORTER_OTLP_PROTOCOL);
	const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || DEFAULT_OTLP_ENDPOINT;
	const tracesEndpoint = resolveOtlpEndpoint(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || baseEndpoint, "traces", protocol);
	const metricsEndpoint = resolveOtlpEndpoint(process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || baseEndpoint, "metrics", protocol);
	const traceHeaders = resolveOtlpHeaders(process.env, tracesEndpoint, "traces");
	const metricHeaders = resolveOtlpHeaders(process.env, metricsEndpoint, "metrics");
	const serviceName = process.env.OTEL_SERVICE_NAME || DEFAULT_SERVICE_NAME;
	const metricInterval = parseMetricExportInterval(process.env.OTEL_METRIC_EXPORT_INTERVAL);
	const account = resolveAccountIdentity(process.env);

	const resourceAttributes = buildResourceAttributes(serviceName, account, process.env.OTEL_RESOURCE_ATTRIBUTES);
	const commonMetricAttributes = buildCommonMetricAttributes(resourceAttributes);
	const resource = new Resource(resourceAttributes);

	const traceProvider = new NodeTracerProvider({ resource });
	traceProvider.addSpanProcessor(new BatchSpanProcessor(createTraceExporter(protocol, tracesEndpoint, traceHeaders)));
	if (debug) traceProvider.addSpanProcessor(new BatchSpanProcessor(new ConsoleSpanExporter()));

	// Do not call traceProvider.register(). OpenTelemetry's global tracer provider is
	// process-wide and only safe to set once; pi /reload creates a fresh extension
	// instance, so this extension uses its local provider directly.
	const tracer: Tracer = traceProvider.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);

	const metricReaders = [
		new PeriodicExportingMetricReader({
			exporter: createMetricExporter(protocol, metricsEndpoint, metricHeaders),
			exportIntervalMillis: metricInterval,
		}),
	];
	if (debug) {
		metricReaders.push(
			new PeriodicExportingMetricReader({
				exporter: new ConsoleMetricExporter(),
				exportIntervalMillis: metricInterval,
			}),
		);
	}

	const meterProvider = new MeterProvider({ resource, readers: metricReaders });
	const meter = meterProvider.getMeter(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);

	const tokensInputCounter = meter.createCounter("pi.tokens.input", { description: "Total input tokens consumed", unit: "tokens" });
	const tokensOutputCounter = meter.createCounter("pi.tokens.output", { description: "Total output tokens produced", unit: "tokens" });
	const toolCallsCounter = meter.createCounter("pi.tool.calls", { description: "Total tool invocations" });
	const toolErrorsCounter = meter.createCounter("pi.tool.errors", { description: "Total failed tool invocations" });
	const toolDurationHistogram = meter.createHistogram("pi.tool.duration", { description: "Tool execution duration", unit: "ms" });
	const turnsCounter = meter.createCounter("pi.turns", { description: "Total LLM turns" });
	const promptsCounter = meter.createCounter("pi.prompts", { description: "Total user prompts / agent starts" });
	const sessionDurationHistogram = meter.createHistogram("pi.session.duration", { description: "Session duration", unit: "s" });
	const claudeTokenUsageCounter = meter.createCounter("claude_code_token_usage_tokens", { description: "Claude Code dashboard-compatible token usage alias for pi", unit: "tokens" });
	const claudeSessionCountCounter = meter.createCounter("claude_code_session_count", { description: "Claude Code dashboard-compatible session count alias for pi" });
	const claudeActiveTimeCounter = meter.createCounter("claude_code_active_time_seconds", { description: "Claude Code dashboard-compatible active time alias for pi", unit: "s" });

	let sessionSpan: Span | undefined;
	let sessionContext: Context = context.active();
	let agentSpan: Span | undefined;
	let agentContext: Context = context.active();
	let turnSpan: Span | undefined;
	let turnContext: Context = context.active();
	const toolSpans = new Map<string, ToolSpanEntry>();

	let sessionStartedAt = 0;
	let turnCount = 0;
	let totalToolCalls = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let currentModel = "";
	let sessionProjectName = "unknown";
	let agentTurnCount = 0;

	pi.on("session_start", async (_event, ctx) => {
		sessionStartedAt = Date.now();
		turnCount = 0;
		totalToolCalls = 0;
		totalInputTokens = 0;
		totalOutputTokens = 0;
		currentModel = "";
		sessionProjectName = resolveProjectName(ctx.cwd);
		toolSpans.clear();

		sessionSpan = tracer.startSpan("session", {
			attributes: {
				"session.id": ctx.sessionManager.getSessionFile() ?? "ephemeral",
				"session.cwd": ctx.cwd,
				"user.email": account.email,
				"user.name": account.userName,
				"user.full_name": account.fullName,
				"host.name": account.hostName,
			},
		});
		sessionContext = trace.setSpan(context.active(), sessionSpan);
		agentContext = sessionContext;
		turnContext = sessionContext;

		if (debug && ctx.hasUI) ctx.ui.setStatus("otel", ctx.ui.theme.fg("dim", "📡 OTEL active"));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const endedAt = Date.now();
		if (sessionStartedAt > 0) {
			const durationSec = (endedAt - sessionStartedAt) / 1000;
			sessionDurationHistogram.record(durationSec, commonMetricAttributes);
			if (claudeDashboardCompat) claudeActiveTimeCounter.add(durationSec, claudeAttrs(commonMetricAttributes, sessionProjectName, currentModel));
		}

		for (const [toolCallId, entry] of toolSpans) {
			entry.span.setStatus({ code: SpanStatusCode.ERROR, message: "Session ended before tool span completed" });
			entry.span.setAttribute("tool.call_id", toolCallId);
			entry.span.end();
		}
		toolSpans.clear();

		if (turnSpan) {
			turnSpan.setStatus({ code: SpanStatusCode.OK });
			turnSpan.end();
			turnSpan = undefined;
		}
		if (agentSpan) {
			agentSpan.setStatus({ code: SpanStatusCode.OK });
			agentSpan.end();
			agentSpan = undefined;
		}
		if (sessionSpan) {
			sessionSpan.setAttribute("session.turns", turnCount);
			sessionSpan.setAttribute("session.tool_calls", totalToolCalls);
			sessionSpan.setAttribute("session.tokens.input", totalInputTokens);
			sessionSpan.setAttribute("session.tokens.output", totalOutputTokens);
			if (currentModel) sessionSpan.setAttribute("llm.model", currentModel);
			sessionSpan.setStatus({ code: SpanStatusCode.OK });
			sessionSpan.end();
			sessionSpan = undefined;
		}

		for (const [label, operation] of [
			["metrics forceFlush", () => meterProvider.forceFlush()],
			["traces forceFlush", () => traceProvider.forceFlush()],
			["metrics shutdown", () => meterProvider.shutdown()],
			["traces shutdown", () => traceProvider.shutdown()],
		] as const) {
			try {
				await operation();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (debug && ctx.hasUI) ctx.ui.notify(`OTEL ${label} failed: ${message}`, "warning");
				else console.error(`[otel] ${label} failed: ${message}`);
			}
		}
	});

	pi.on("agent_start", async () => {
		promptsCounter.add(1, commonMetricAttributes);
		if (claudeDashboardCompat) claudeSessionCountCounter.add(1, claudeAttrs(commonMetricAttributes, sessionProjectName, currentModel));
		agentTurnCount = 0;
		agentSpan = tracer.startSpan("agent.prompt", { attributes: { "agent.turn_count": agentTurnCount } }, sessionContext);
		agentContext = trace.setSpan(sessionContext, agentSpan);
	});

	pi.on("agent_end", async (event) => {
		if (!agentSpan) return;
		agentSpan.setAttribute("agent.messages_count", event.messages?.length ?? 0);
		agentSpan.setStatus({ code: SpanStatusCode.OK });
		agentSpan.end();
		agentSpan = undefined;
		agentContext = sessionContext;
	});

	pi.on("turn_start", async (event) => {
		turnCount++;
		agentTurnCount++;
		turnsCounter.add(1, commonMetricAttributes);
		if (agentSpan) agentSpan.setAttribute("agent.turn_count", agentTurnCount);

		turnSpan = tracer.startSpan(
			"agent.turn",
			{
				attributes: {
					"turn.index": event.turnIndex,
					"turn.number": turnCount,
				},
			},
			agentContext,
		);
		turnContext = trace.setSpan(agentContext, turnSpan);
	});

	pi.on("turn_end", async (event) => {
		if (!turnSpan) return;

		turnSpan.setAttribute("turn.tool_results", event.toolResults?.length ?? 0);
		const usage = extractUsage(event.message);
		if (usage) {
			turnSpan.setAttribute("llm.usage.input_tokens", usage.input);
			turnSpan.setAttribute("llm.usage.output_tokens", usage.output);
			turnSpan.setAttribute("llm.usage.cache_read_tokens", usage.cacheRead);
			turnSpan.setAttribute("llm.usage.cache_write_tokens", usage.cacheWrite);
			turnSpan.setAttribute("llm.usage.total_tokens", usage.totalTokens);

			const inputWithCache = usage.input + usage.cacheRead + usage.cacheWrite;
			totalInputTokens += inputWithCache;
			totalOutputTokens += usage.output;
			tokensInputCounter.add(inputWithCache, commonMetricAttributes);
			tokensOutputCounter.add(usage.output, commonMetricAttributes);
			if (claudeDashboardCompat) {
				recordClaudeTokenUsage(claudeTokenUsageCounter, commonMetricAttributes, sessionProjectName, currentModel, "input", usage.input);
				recordClaudeTokenUsage(claudeTokenUsageCounter, commonMetricAttributes, sessionProjectName, currentModel, "output", usage.output);
				recordClaudeTokenUsage(claudeTokenUsageCounter, commonMetricAttributes, sessionProjectName, currentModel, "cacheRead", usage.cacheRead);
				recordClaudeTokenUsage(claudeTokenUsageCounter, commonMetricAttributes, sessionProjectName, currentModel, "cacheCreation", usage.cacheWrite);
			}
		}

		turnSpan.setStatus({ code: SpanStatusCode.OK });
		turnSpan.end();
		turnSpan = undefined;
		turnContext = agentContext;
	});

	pi.on("tool_execution_start", async (event) => {
		totalToolCalls++;
		const toolAttributes = withToolName(commonMetricAttributes, event.toolName);
		toolCallsCounter.add(1, toolAttributes);

		const span = tracer.startSpan(
			`tool.${event.toolName}`,
			{
				attributes: {
					"tool.name": event.toolName,
					"tool.call_id": event.toolCallId,
					"tool.args_summary": summarizeToolArgs(event.toolName, event.args),
				},
			},
			turnContext,
		);
		toolSpans.set(event.toolCallId, { span, startTime: Date.now() });
	});

	pi.on("tool_execution_end", async (event) => {
		const entry = toolSpans.get(event.toolCallId);
		if (!entry) return;

		const durationMs = Date.now() - entry.startTime;
		const toolAttributes = withToolName(commonMetricAttributes, event.toolName);
		toolDurationHistogram.record(durationMs, toolAttributes);

		if (event.isError) {
			toolErrorsCounter.add(1, toolAttributes);
			entry.span.setStatus({ code: SpanStatusCode.ERROR, message: "Tool execution failed" });
		} else {
			entry.span.setStatus({ code: SpanStatusCode.OK });
		}

		entry.span.setAttribute("tool.is_error", event.isError ?? false);
		entry.span.setAttribute("tool.duration_ms", durationMs);
		entry.span.end();
		toolSpans.delete(event.toolCallId);
	});

	pi.on("model_select", async (event) => {
		currentModel = `${event.model.provider}/${event.model.id}`;
		if (!sessionSpan) return;

		sessionSpan.setAttribute("llm.model", currentModel);
		if (event.previousModel) {
			sessionSpan.addEvent("model.changed", {
				"model.previous": `${event.previousModel.provider}/${event.previousModel.id}`,
				"model.current": currentModel,
				"model.source": event.source,
			});
		}
	});

	pi.on("session_compact", async (event) => {
		if (!sessionSpan) return;
		sessionSpan.addEvent("session.compacted", {
			"compaction.from_extension": event.fromExtension ?? false,
		});
	});

	pi.on("before_provider_request", (event) => {
		if (!turnSpan) return;
		turnSpan.addEvent("llm.request", {
			"llm.payload_size": safeJsonLength(event.payload),
		});
	});
}

export function resolveOtlpHttpEndpoint(endpoint: string, signal: OtlpSignal): string {
	const trimmed = endpoint.replace(/\/+$/, "");
	if (trimmed.endsWith(`/v1/${signal}`)) return trimmed;
	if (trimmed.endsWith("/v1/traces") || trimmed.endsWith("/v1/metrics")) return trimmed;
	return `${trimmed}/v1/${signal}`;
}

export function resolveOtlpProtocol(value: string | undefined): OtlpProtocol {
	return value?.toLowerCase() === "grpc" ? "grpc" : "http/protobuf";
}

export function resolveOtlpEndpoint(endpoint: string, signal: OtlpSignal, protocol: OtlpProtocol): string {
	if (protocol === "grpc") return endpoint.replace(/\/+$/, "");
	return resolveOtlpHttpEndpoint(endpoint, signal);
}

export function parseOtlpHeaders(value: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {};
	if (!value) return headers;

	for (const rawPair of value.split(",")) {
		const pair = rawPair.trim();
		if (!pair) continue;
		const equalsIndex = pair.indexOf("=");
		if (equalsIndex <= 0) continue;
		const key = decodeHeaderPart(pair.slice(0, equalsIndex).trim());
		const headerValue = decodeHeaderPart(pair.slice(equalsIndex + 1).trim());
		if (!key) continue;
		headers[key] = headerValue;
	}

	return headers;
}

export function resolveOtlpHeaders(env: NodeJS.ProcessEnv, endpoint: string, signal: OtlpSignal, resolvers: OtlpHeaderResolvers = {}): Record<string, string> {
	const signalEnv = signal === "traces" ? env.OTEL_EXPORTER_OTLP_TRACES_HEADERS : env.OTEL_EXPORTER_OTLP_METRICS_HEADERS;
	const headers = {
		...parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
		...parseOtlpHeaders(signalEnv),
	};

	if (!hasAuthorizationHeader(headers) && shouldUseCnbAuthFallback(env, endpoint)) {
		const token = (resolvers.cnbAuthToken ?? readCnbAuthToken)();
		if (token) headers.Authorization = `Bearer ${token}`;
	}

	return headers;
}

export function shouldUseCnbAuthFallback(env: NodeJS.ProcessEnv, endpoint: string): boolean {
	if (env.PI_OTEL_CNB_AUTH === "false") return false;
	if (env.PI_OTEL_CNB_AUTH === "true") return true;
	try {
		const host = new URL(endpoint).hostname;
		return host === "otlp.lan.cnb.rocks" || host.endsWith(".cnb.rocks");
	} catch {
		return false;
	}
}

export function parseOtelResourceAttributes(value: string | undefined): Attributes {
	const attributes: Attributes = {};
	if (!value) return attributes;

	for (const rawPair of value.split(",")) {
		const pair = rawPair.trim();
		if (!pair) continue;
		const equalsIndex = pair.indexOf("=");
		if (equalsIndex <= 0) continue;
		const key = pair.slice(0, equalsIndex).trim();
		const rawValue = pair.slice(equalsIndex + 1).trim();
		if (!key) continue;
		attributes[key] = rawValue;
	}

	return attributes;
}

export function buildResourceAttributes(serviceName: string, account: AccountIdentity, envResourceAttributes?: string): Attributes {
	return {
		[ATTR_SERVICE_NAME]: serviceName,
		[ATTR_SERVICE_VERSION]: INSTRUMENTATION_VERSION,
		"pi.extension": "otel",
		"host.name": account.hostName,
		"user.name": account.userName,
		...(account.email ? { "user.email": account.email } : {}),
		...(account.fullName ? { "user.full_name": account.fullName } : {}),
		...parseOtelResourceAttributes(envResourceAttributes),
	};
}

export function buildCommonMetricAttributes(resourceAttributes: Attributes): Attributes {
	const common: Attributes = {};
	copyStringAttribute(resourceAttributes, common, "user.name");
	copyStringAttribute(resourceAttributes, common, "user.email");
	copyStringAttribute(resourceAttributes, common, "environment");
	copyStringAttribute(resourceAttributes, common, "deployment.environment");
	copyStringAttribute(resourceAttributes, common, "host.name");
	return common;
}

export function resolveProjectName(cwd: string): string {
	const name = basename(cwd.replace(/\/+$/, ""));
	return name || "unknown";
}

export function claudeAttrs(commonMetricAttributes: Attributes, projectName: string, model: string): Attributes {
	return {
		...commonMetricAttributes,
		project_name: projectName || "unknown",
		model: model || "unknown",
	};
}

export function summarizeToolArgs(toolName: string, args: unknown): string {
	if (args === undefined || args === null) return "";
	if (!isRecord(args)) return truncate(String(args), TOOL_ARG_SUMMARY_LIMIT);

	switch (toolName) {
		case "bash":
			return truncate(stringValue(args.command), TOOL_ARG_SUMMARY_LIMIT);
		case "read":
		case "write":
		case "edit":
			return truncate(stringValue(args.path), TOOL_ARG_SUMMARY_LIMIT);
		default:
			try {
				return truncate(JSON.stringify(args), TOOL_ARG_SUMMARY_LIMIT);
			} catch {
				return "[unserializable]";
			}
	}
}

export function truncate(value: string, maxLength: number): string {
	if (maxLength < 1) return "";
	return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

export function resolveAccountIdentity(env: NodeJS.ProcessEnv = process.env, resolvers: AccountIdentityResolvers = {}): AccountIdentity {
	const readGitConfig = resolvers.gitConfig ?? gitConfig;
	const readUserName = resolvers.userName ?? (() => userInfo().username);
	const readHostName = resolvers.hostName ?? (() => hostname());

	return {
		email: env.PI_OTEL_USER_EMAIL || readGitConfig("user.email") || "",
		fullName: env.PI_OTEL_USER_NAME || readGitConfig("user.name") || "",
		userName: readUserName(),
		hostName: readHostName(),
	};
}

export function parseMetricExportInterval(value: string | undefined): number {
	if (!value) return DEFAULT_METRIC_EXPORT_INTERVAL_MS;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_METRIC_EXPORT_INTERVAL_MS;
}

function recordClaudeTokenUsage(counter: { add: (value: number, attributes?: Attributes) => void }, commonMetricAttributes: Attributes, projectName: string, model: string, type: string, value: number): void {
	if (value <= 0) return;
	counter.add(value, { ...claudeAttrs(commonMetricAttributes, projectName, model), type });
}

function createTraceExporter(protocol: OtlpProtocol, url: string, headers: Record<string, string>): OTLPGrpcTraceExporter | OTLPHttpTraceExporter {
	if (protocol === "grpc") return new OTLPGrpcTraceExporter({ url, metadata: toGrpcMetadata(headers) });
	return new OTLPHttpTraceExporter({ url, headers });
}

function createMetricExporter(protocol: OtlpProtocol, url: string, headers: Record<string, string>): OTLPGrpcMetricExporter | OTLPHttpMetricExporter {
	if (protocol === "grpc") return new OTLPGrpcMetricExporter({ url, metadata: toGrpcMetadata(headers) });
	return new OTLPHttpMetricExporter({ url, headers });
}

function toGrpcMetadata(headers: Record<string, string>): Metadata {
	const metadata = new Metadata();
	for (const [key, value] of Object.entries(headers)) {
		if (!key || value === undefined) continue;
		metadata.set(key.toLowerCase(), value);
	}
	return metadata;
}

function readCnbAuthToken(): string {
	try {
		return execFileSync("cnb", ["auth", "token"], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return "";
	}
}

function gitConfig(key: string): string {
	try {
		return execFileSync("git", ["config", "--global", key], { encoding: "utf8", timeout: 2000 }).trim();
	} catch {
		return "";
	}
}

function extractUsage(message: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number } | undefined {
	if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) return undefined;
	return {
		input: numberValue(message.usage.input),
		output: numberValue(message.usage.output),
		cacheRead: numberValue(message.usage.cacheRead),
		cacheWrite: numberValue(message.usage.cacheWrite),
		totalTokens: numberValue(message.usage.totalTokens),
	};
}

function safeJsonLength(value: unknown): number {
	try {
		return JSON.stringify(value).length;
	} catch {
		return 0;
	}
}

function withToolName(attributes: Attributes, toolName: string): Attributes {
	return { ...attributes, "tool.name": toolName };
}

function copyStringAttribute(source: Attributes, target: Attributes, key: string): void {
	const value = source[key];
	if (typeof value === "string" && value.length > 0) target[key] = value;
}

function decodeHeaderPart(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function hasAuthorizationHeader(headers: Record<string, string>): boolean {
	return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
