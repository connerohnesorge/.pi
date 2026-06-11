import { describe, expect, it } from "vitest";
import registerOtelTelemetry, {
	buildCommonMetricAttributes,
	buildResourceAttributes,
	claudeAttrs,
	formatModel,
	parseMetricExportInterval,
	parseOtelResourceAttributes,
	parseOtlpHeaders,
	resolveAccountIdentity,
	resolveOtlpEndpoint,
	resolveOtlpHeaders,
	resolveOtlpHttpEndpoint,
	resolveOtlpProtocol,
	resolveProjectName,
	shouldUseCnbAuthFallback,
	summarizeToolArgs,
	truncate,
	type AccountIdentity,
} from "./index.ts";

const account: AccountIdentity = {
	email: "agent@example.com",
	fullName: "Pi Agent",
	userName: "agent",
	hostName: "host-a",
};

describe("registerOtelTelemetry", () => {
	it("registers no hooks when disabled", () => {
		const previous = process.env.PI_OTEL_ENABLED;
		process.env.PI_OTEL_ENABLED = "false";
		const calls: string[] = [];

		registerOtelTelemetry({
			on: (eventName: string) => {
				calls.push(eventName);
			},
		} as never);

		expect(calls).toEqual([]);
		if (previous === undefined) delete process.env.PI_OTEL_ENABLED;
		else process.env.PI_OTEL_ENABLED = previous;
	});
});

describe("resolveOtlpHttpEndpoint", () => {
	it("appends signal paths to a base endpoint", () => {
		expect(resolveOtlpHttpEndpoint("http://localhost:4318", "traces")).toBe("http://localhost:4318/v1/traces");
		expect(resolveOtlpHttpEndpoint("http://localhost:4318/", "metrics")).toBe("http://localhost:4318/v1/metrics");
	});

	it("does not duplicate existing signal paths", () => {
		expect(resolveOtlpHttpEndpoint("http://collector/v1/traces", "traces")).toBe("http://collector/v1/traces");
		expect(resolveOtlpHttpEndpoint("http://collector/v1/metrics", "metrics")).toBe("http://collector/v1/metrics");
	});

	it("leaves the other signal-specific path unchanged", () => {
		expect(resolveOtlpHttpEndpoint("http://collector/v1/traces", "metrics")).toBe("http://collector/v1/traces");
	});
});

describe("OTLP protocol and headers", () => {
	it("uses grpc endpoints without appending HTTP signal paths", () => {
		expect(resolveOtlpProtocol("grpc")).toBe("grpc");
		expect(resolveOtlpProtocol("http/protobuf")).toBe("http/protobuf");
		expect(resolveOtlpEndpoint("https://otlp.lan.cnb.rocks:443/", "traces", "grpc")).toBe("https://otlp.lan.cnb.rocks:443");
		expect(resolveOtlpEndpoint("https://collector", "metrics", "http/protobuf")).toBe("https://collector/v1/metrics");
	});

	it("parses OTLP headers and decodes URL-encoded values", () => {
		expect(parseOtlpHeaders("Authorization=Bearer%20token,x-team=platform")).toEqual({
			Authorization: "Bearer token",
			"x-team": "platform",
		});
	});

	it("merges signal-specific headers over common headers", () => {
		const headers = resolveOtlpHeaders(
			{
				OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer common,x-shared=yes",
				OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=Bearer trace",
			},
			"https://collector.example.com",
			"traces",
			{ cnbAuthToken: () => "unused" },
		);

		expect(headers).toEqual({
			Authorization: "Bearer trace",
			"x-shared": "yes",
		});
	});

	it("adds a cnb bearer token for the athens collector when no auth header exists", () => {
		const headers = resolveOtlpHeaders({}, "https://otlp.lan.cnb.rocks:443", "metrics", { cnbAuthToken: () => "cnb-token" });
		expect(headers.Authorization).toBe("Bearer cnb-token");
	});

	it("allows cnb bearer fallback to be disabled", () => {
		expect(shouldUseCnbAuthFallback({ PI_OTEL_CNB_AUTH: "false" }, "https://otlp.lan.cnb.rocks:443")).toBe(false);
		expect(resolveOtlpHeaders({ PI_OTEL_CNB_AUTH: "false" }, "https://otlp.lan.cnb.rocks:443", "metrics", { cnbAuthToken: () => "cnb-token" })).toEqual({});
	});
});

describe("parseOtelResourceAttributes", () => {
	it("parses comma-separated key-value pairs", () => {
		expect(parseOtelResourceAttributes("environment=dev,team=platform,empty=" )).toEqual({
			environment: "dev",
			team: "platform",
			empty: "",
		});
	});

	it("ignores malformed or empty pairs", () => {
		expect(parseOtelResourceAttributes("ok=yes,nope,=bad, also = good ")).toEqual({
			ok: "yes",
			also: "good",
		});
	});
});

describe("resource and metric attributes", () => {
	it("builds resource attributes and lets OTEL_RESOURCE_ATTRIBUTES override defaults", () => {
		const attributes = buildResourceAttributes("pi-test", account, "environment=test,user.name=override");

		expect(attributes["service.name"]).toBe("pi-test");
		expect(attributes["pi.extension"]).toBe("otel");
		expect(attributes["user.email"]).toBe("agent@example.com");
		expect(attributes["user.name"]).toBe("override");
		expect(attributes.environment).toBe("test");
	});

	it("copies only bounded common metric attributes", () => {
		const common = buildCommonMetricAttributes({
			"user.name": "agent",
			"user.email": "agent@example.com",
			"host.name": "host-a",
			environment: "prod",
			"deployment.environment": "workstation",
			"session.id": "too-cardinal",
		});

		expect(common).toEqual({
			"user.name": "agent",
			"user.email": "agent@example.com",
			environment: "prod",
			"deployment.environment": "workstation",
			"host.name": "host-a",
		});
	});

	it("builds Claude dashboard-compatible attributes", () => {
		expect(resolveProjectName("/Users/cohnesor/.pi/agent/extensions/otel")).toBe("otel");
		expect(claudeAttrs({ "user.email": "agent@example.com" }, "otel", "model-name")).toEqual({
			"user.email": "agent@example.com",
			project_name: "otel",
			model: "model-name",
			query_source: "main",
		});
		expect(formatModel({ provider: "openai-codex", id: "gpt-5.4" })).toEqual({
			full: "openai-codex/gpt-5.4",
			dashboard: "gpt-5.4",
		});
	});
});

describe("summarizeToolArgs", () => {
	it("summarizes common built-in tool arguments", () => {
		expect(summarizeToolArgs("bash", { command: "npm test" })).toBe("npm test");
		expect(summarizeToolArgs("read", { path: "src/index.ts" })).toBe("src/index.ts");
		expect(summarizeToolArgs("write", { path: "README.md", content: "large" })).toBe("README.md");
		expect(summarizeToolArgs("edit", { path: "index.ts", edits: [] })).toBe("index.ts");
	});

	it("truncates large argument summaries", () => {
		const summary = summarizeToolArgs("bash", { command: "x".repeat(250) });
		expect(summary).toHaveLength(201);
		expect(summary.endsWith("…")).toBe(true);
	});

	it("serializes generic args and protects against circular values", () => {
		expect(summarizeToolArgs("custom", { action: "run" })).toBe('{"action":"run"}');

		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(summarizeToolArgs("custom", circular)).toBe("[unserializable]");
	});
});

describe("truncate", () => {
	it("returns short strings unchanged", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});

	it("caps long strings and appends an ellipsis", () => {
		expect(truncate("hello world", 5)).toBe("hello…");
	});

	it("returns an empty string when max length is less than one", () => {
		expect(truncate("hello", 0)).toBe("");
	});
});

describe("resolveAccountIdentity", () => {
	it("prefers environment identity over git config", () => {
		const identity = resolveAccountIdentity(
			{ PI_OTEL_USER_EMAIL: "env@example.com", PI_OTEL_USER_NAME: "Env Name" },
			{
				gitConfig: (key) => (key === "user.email" ? "git@example.com" : "Git Name"),
				userName: () => "os-user",
				hostName: () => "host-b",
			},
		);

		expect(identity).toEqual({
			email: "env@example.com",
			fullName: "Env Name",
			userName: "os-user",
			hostName: "host-b",
		});
	});

	it("falls back to git config for email and full name", () => {
		const identity = resolveAccountIdentity(
			{},
			{
				gitConfig: (key) => (key === "user.email" ? "git@example.com" : "Git Name"),
				userName: () => "os-user",
				hostName: () => "host-b",
			},
		);

		expect(identity.email).toBe("git@example.com");
		expect(identity.fullName).toBe("Git Name");
		expect(identity.userName).toBe("os-user");
		expect(identity.hostName).toBe("host-b");
	});
});

describe("parseMetricExportInterval", () => {
	it("returns a positive integer or the default", () => {
		expect(parseMetricExportInterval("2500")).toBe(2500);
		expect(parseMetricExportInterval("0")).toBe(10_000);
		expect(parseMetricExportInterval("nope")).toBe(10_000);
		expect(parseMetricExportInterval(undefined)).toBe(10_000);
	});
});
