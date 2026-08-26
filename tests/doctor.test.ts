import { describe, expect, it } from "vitest";
import { buildDoctorReport, renderDoctorReport } from "../src/tools/doctor.js";
import { AdapterRegistry } from "../src/core/registry.js";
import { CooldownBoard } from "../src/core/cooldown.js";
import type { ConfigType } from "../src/config.js";
import type { SearchAdapter } from "../src/types.js";

function fakeAdapter(id: string, over: Partial<SearchAdapter> = {}): SearchAdapter {
	return {
		id,
		label: `${id} label`,
		requiresApiKey: false,
		defaultApiKeyEnv: `${id.toUpperCase()}_API_KEY`,
		baseURLEnv: `${id.toUpperCase()}_BASE_URL`,
		defaultBaseURL: `https://${id}.test`,
		available: () => true,
		search: () => Promise.resolve({ sources: [], truncated: false }),
		...over,
	} as SearchAdapter;
}

const FAKE_SECRETS = ["fc-secret-abc123", "tvly-top-secret-999"];

function makeConfig(over: Partial<ConfigType> = {}): ConfigType {
	return {
		provider: "firecrawl-keyless",
		apiKeyEnv: "FIRECRAWL_API_KEY",
		fallbacks: ["tavily"],
		baseURL: "",
		limits: { extractMaxUrls: 10, crawlMaxPages: 10, mapMaxUrls: 100, perPageChars: 20000 },
		tools: { extract: true, crawl: true, map: true, research: false, doctor: true },
		firecrawl: {},
		tavily: {},
		deepseek: {},
		...over,
	} as unknown as ConfigType;
}

/** Resolver + env deliberately hold REAL-LOOKING secrets the output must never echo. */
function makeDeps(config: ConfigType, registry: AdapterRegistry, over: { env?: Record<string, string>; cooldowns?: CooldownBoard } = {}) {
	const env = { FIRECRAWL_API_KEY: FAKE_SECRETS[0]!, TAVILY_BASE_URL: "https://tavily-env.test", ...over.env };
	return {
		registry,
		config,
		envLookup: (name: string) => env[name],
		refResolves: async (refName: string) => refName === "FIRECRAWL_API_KEY",
		cooldowns: over.cooldowns,
	};
}

describe("doctor report (offline)", () => {
	it("lists EVERY registry member with role, key-ref boolean, endpoint source, and availability", async () => {
		const registry = new AdapterRegistry();
		registry.register(fakeAdapter("firecrawl-keyless"));
		registry.register(fakeAdapter("tavily", { requiresApiKey: false }));
		registry.register(fakeAdapter("demo", { defaultApiKeyEnv: "DSH_WEB_SEARCH_DEMO_KEY" }));
		const report = await buildDoctorReport(makeDeps(makeConfig(), registry));
		expect(report.adapters.map((adapter) => adapter.id)).toEqual(["firecrawl-keyless", "tavily", "demo"]);
		expect(report.effectiveChain).toEqual(["firecrawl-keyless", "tavily"]);
		expect(report.problems).toEqual([]);
		const [primary, fallback, standby] = report.adapters;
		expect(primary?.chainRole).toBe("primary");
		expect(fallback?.chainRole).toBe("fallback");
		expect(standby?.chainRole).toBe("standby");
		// Top-level apiKeyEnv wins for every member (mirrors resolveOptions).
		expect(primary?.credentialRef).toBe("FIRECRAWL_API_KEY");
		expect(primary?.credentialResolves).toBe(true);
		expect(fallback?.credentialRef).toBe("FIRECRAWL_API_KEY");
		expect(fallback?.credentialResolves).toBe(true);
		expect(primary?.baseURLSource).toBe("default");
		expect(fallback?.baseURLSource).toBe("env");
		expect(fallback?.baseURL).toBe("https://tavily-env.test");
	});

	it("mirrors resolveOptions' nullish ref ladder: ANY top-level string shadows subsections", async () => {
		const registry = new AdapterRegistry();
		registry.register(fakeAdapter("firecrawl-keyless"));
		registry.register(fakeAdapter("tavily"));
		const config = makeConfig({ apiKeyEnv: "", tavily: { apiKeyEnv: "TAVILY_API_KEY" } } as Partial<ConfigType>);
		const report = await buildDoctorReport(makeDeps(config, registry));
		// An EMPTY-string top-level value is still non-nullish, so it wins for
		// every member - exactly what resolveOptions would resolve at runtime.
		expect(report.adapters[0]?.credentialRef).toBe("");
		expect(report.adapters[1]?.credentialRef).toBe("");
	});

	it("labels config-overridden endpoints and surfaces chain validation problems", async () => {
		const registry = new AdapterRegistry();
		registry.register(fakeAdapter("firecrawl-keyless"));
		registry.register(fakeAdapter("demo"));
		const report = await buildDoctorReport(makeDeps(makeConfig({ baseURL: "https://proxy.internal", fallbacks: ["ghost", "demo", "ghost"] }), registry));
		expect(report.effectiveChain).toEqual(["firecrawl-keyless", "demo"]);
		expect(report.problems).toEqual(['fallbacks: unknown adapter "ghost"']);
		for (const adapter of report.adapters) expect(adapter.baseURLSource).toBe("config");
	});

	it("reflects cooldown windows from the board as ISO timestamps", async () => {
		const registry = new AdapterRegistry();
		registry.register(fakeAdapter("firecrawl-keyless"));
		const cooldowns = new CooldownBoard({ clock: () => 1_000 });
		cooldowns.onQuotaError("firecrawl-keyless");
		const report = await buildDoctorReport(makeDeps(makeConfig({ fallbacks: [] }), registry, { cooldowns }));
		expect(report.adapters[0]?.coolingUntil).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("NEVER prints anything key-like: configured secret values are absent from the text", async () => {
		const registry = new AdapterRegistry();
		registry.register(fakeAdapter("firecrawl-keyless"));
		registry.register(fakeAdapter("tavily"));
		const report = await buildDoctorReport(makeDeps(makeConfig(), registry));
		const text = renderDoctorReport(report);
		expect(text).toContain("credential FIRECRAWL_API_KEY resolves: true");
		for (const secret of FAKE_SECRETS) expect(text).not.toContain(secret);
		expect(text).not.toMatch(/fc-[A-Za-z0-9]|tvly-[A-Za-z0-9]/u);
	});
});
