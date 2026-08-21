import { register } from "node:module";
register("./loader.mjs", import.meta.url);

const { ExtensibleWebSearchProvider, SEARCH_PROVIDER_ID } = await import("../lib/core/provider.js");
const { createDefaultRegistry } = await import("../lib/adapters/index.js");
const { AdapterRegistry } = await import("../lib/core/registry.js");

const registry = createDefaultRegistry();

function providerOf(providerId, over = {}) {
	const adapter = registry.get(providerId);
	return new ExtensibleWebSearchProvider(() => ({
		provider: providerId,
		apiKeyEnv: adapter.defaultApiKeyEnv,
		baseURL: adapter.defaultBaseURL,
		adapter,
		settings:
			providerId === "tavily"
				? { searchDepth: "basic", topic: "general", maxResults: 5, includeAnswer: true, timeRange: "" }
				: providerId === "deepseek"
					? { model: "deepseek-v4-flash", apiVersion: "2023-06-01", maxTokens: 4096, maxUses: 5 }
					: {},
		recordRequest: () => {},
		...over,
	}));
}

// 0. Registered provider id is the OFFICIAL slot regardless of internal adapter.
{
	const p = providerOf("demo");
	console.log("TEST 0 registered id:", p.id, "=>", p.id === SEARCH_PROVIDER_ID && p.id === "deepseek-official" ? "PASS" : "FAIL");
	if (p.id !== SEARCH_PROVIDER_ID) process.exitCode = 1;
}

// 1. Tavily KEYLESS happy path: mapping + dedupe by URL.
{
	const p = providerOf("tavily"); // no apiKey -> keyless
	const res = await p.search({ query: "latest AI news", maxResults: 10 });
	console.log("TEST 1 keyless sources:", res.sources.length, "truncated:", res.truncated);
	console.log("  content:", JSON.stringify(res.content));
	const ok =
		res.sources.length === 2 &&
		res.sources[0].url === "https://example.com/a" &&
		res.sources[1].url === "https://example.com/b" &&
		res.content === "Tavily generated answer for: latest AI news" &&
		res.truncated === false;
	console.log("  =>", ok ? "PASS" : "FAIL");
	if (!ok) process.exitCode = 1;
}

// 2. request.maxResults overrides the adapter default.
{
	globalThis.__lastTavilyCall = undefined;
	const p = providerOf("tavily");
	await p.search({ query: "q", maxResults: 3 });
	console.log("TEST 2 request maxResults ->", globalThis.__lastTavilyCall.params.maxResults, "(expect 3)");
	if (globalThis.__lastTavilyCall.params.maxResults !== 3) process.exitCode = 1;
}

// 3. Tavily SDK rejects -> WEB_PROVIDER_ERROR (wrapping).
{
	globalThis.__tavilyThrow = "upstream 500";
	const p = providerOf("tavily", { apiKey: "tvly-test" });
	try {
		await p.search({ query: "q" });
		console.log("TEST 3 => FAIL (should have thrown)");
		process.exitCode = 1;
	} catch (e) {
		console.log("TEST 3 provider error:", e.code, "=>", e.code === "WEB_PROVIDER_ERROR" ? "PASS" : "FAIL");
		if (e.code !== "WEB_PROVIDER_ERROR") process.exitCode = 1;
	} finally {
		globalThis.__tavilyThrow = undefined;
	}
}

// 4. Abort before dispatch -> WEB_ABORTED.
{
	const p = providerOf("tavily", { apiKey: "tvly-test" });
	const ac = new AbortController();
	ac.abort(new Error("user cancelled"));
	try {
		await p.search({ query: "q" }, ac.signal);
		console.log("TEST 4 => FAIL (should have thrown)");
		process.exitCode = 1;
	} catch (e) {
		console.log("TEST 4 abort:", e.code, "=>", e.code === "WEB_ABORTED" ? "PASS" : "FAIL");
		if (e.code !== "WEB_ABORTED") process.exitCode = 1;
	}
}

// 5. Demo adapter: pluggable, no network, no key — internal provider switch works.
{
	const p = providerOf("demo");
	const res = await p.search({ query: "hello" });
	console.log("TEST 5 demo sources:", res.sources.length, "content:", JSON.stringify(res.content));
	const ok = p.id === "deepseek-official" && res.sources.length === 2 && res.content === "Demo adapter echoed: hello";
	console.log("  =>", ok ? "PASS" : "FAIL");
	if (!ok) process.exitCode = 1;
}

// 6. Credential-missing path: a key-required adapter with no key -> WEB_PROVIDER_CREDENTIAL_MISSING.
{
	const keyReq = {
		id: "keyreq",
		label: "KeyReq",
		requiresApiKey: true,
		defaultApiKeyEnv: "KEYREQ_KEY",
		baseURLEnv: "KEYREQ_BASE_URL",
		defaultBaseURL: "https://example.invalid",
		available: () => true,
		async search() {
			return { sources: [], truncated: false };
		},
	};
	const reg = new AdapterRegistry();
	reg.register(keyReq);
	const p = new ExtensibleWebSearchProvider(() => ({
		provider: "keyreq",
		apiKeyEnv: "KEYREQ_KEY",
		baseURL: "https://example.invalid",
		adapter: keyReq,
		settings: {},
		recordRequest: () => {},
	}));
	try {
		await p.search({ query: "q" });
		console.log("TEST 6 => FAIL (should have thrown)");
		process.exitCode = 1;
	} catch (e) {
		console.log("TEST 6 credential missing:", e.code, "=>", e.code === "WEB_PROVIDER_CREDENTIAL_MISSING" ? "PASS" : "FAIL");
		if (e.code !== "WEB_PROVIDER_CREDENTIAL_MISSING") process.exitCode = 1;
	}
}

// 7. DeepSeek adapter: mocked Messages API -> tools block mapping + request body shape.
{
	globalThis.__deepseekCall = undefined;
	globalThis.fetch = async (url, init) => {
		globalThis.__deepseekCall = { url, body: JSON.parse(init.body), auth: init.headers["x-api-key"] };
		return {
			ok: true,
			json: async () => ({
				content: [
					{
						type: "web_search_tool_result",
						content: [
							{ type: "web_search_result", url: "https://deep/1", title: "DeepOne", page_age: "2024-03-03" },
						],
					},
				],
			}),
		};
	};
	const p = providerOf("deepseek", { apiKey: "dk-secret" });
	const res = await p.search({ query: "deep q" });
	console.log("TEST 7 deepseek sources:", res.sources[0]?.url, "publishedAt:", res.sources[0]?.publishedAt, "endpoint:", globalThis.__deepseekCall.url);
	const ok =
		res.sources[0]?.url === "https://deep/1" &&
		res.sources[0]?.publishedAt === "2024-03-03" &&
		globalThis.__deepseekCall.url === "https://api.deepseek.com/anthropic/v1/messages" &&
		globalThis.__deepseekCall.auth === "dk-secret" &&
		globalThis.__deepseekCall.body.tools[0].type === "web_search_20250305";
	console.log("  =>", ok ? "PASS" : "FAIL");
	if (!ok) process.exitCode = 1;
	globalThis.fetch = undefined;
}

// 8. DeepSeek without a key -> WEB_PROVIDER_CREDENTIAL_MISSING (key-required backend).
{
	const p = providerOf("deepseek");
	try {
		await p.search({ query: "q" });
		console.log("TEST 8 => FAIL (should have thrown)");
		process.exitCode = 1;
	} catch (e) {
		console.log("TEST 8 deepseek no-key:", e.code, "=>", e.code === "WEB_PROVIDER_CREDENTIAL_MISSING" ? "PASS" : "FAIL");
		if (e.code !== "WEB_PROVIDER_CREDENTIAL_MISSING") process.exitCode = 1;
	}
}

console.log(process.exitCode ? "SOME TESTS FAILED" : "ALL SEARCH TESTS PASSED");
