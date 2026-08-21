import { apply, Config, name, inject } from "./lib/index.js";
import { ExtensibleWebSearchProvider, SEARCH_PROVIDER_ID } from "./lib/core/provider.js";
import { createDefaultRegistry } from "./lib/adapters/index.js";
import { apply as invariantApply, name as invariantName, inject as invariantInject } from "./lib/invariant.js";

console.log("plugin name     :", name, "(official identity: web-search-deepseek)");
console.log("plugin inject   :", JSON.stringify(inject));
console.log("Config schema    :", Config?.type);
console.log("registered id   :", SEARCH_PROVIDER_ID, "(official slot: deepseek-official)");
console.log("invariant name   :", invariantName, "inject", JSON.stringify(invariantInject));

const registry = createDefaultRegistry();
console.log("adapters         :", registry.list().map((a) => `${a.id}(${a.requiresApiKey ? "key" : "keyless"})`).join(", "));

const tavilyOpts = (over) => ({
	provider: "tavily",
	apiKeyEnv: "TAVILY_API_KEY",
	baseURL: "https://api.tavily.com",
	adapter: registry.get("tavily"),
	settings: { searchDepth: "basic", topic: "general", maxResults: 5, includeAnswer: true, timeRange: "" },
	recordRequest: () => {},
	...over,
});

const pKey = new ExtensibleWebSearchProvider(() => tavilyOpts({ apiKey: "tvly-test" }));
console.log("tavily+key id    :", pKey.id, "available:", pKey.available());

const pKeyless = new ExtensibleWebSearchProvider(() => tavilyOpts({}));
console.log("tavily keyless   : available:", pKeyless.available(), "(keyless => usable without key)");

const pDeepseek = new ExtensibleWebSearchProvider(() => ({
	provider: "deepseek",
	apiKeyEnv: "DEEPSEEK_API_KEY",
	baseURL: "https://api.deepseek.com/anthropic/v1",
	adapter: registry.get("deepseek"),
	settings: { model: "deepseek-v4-flash", apiVersion: "2023-06-01", maxTokens: 4096, maxUses: 5 },
	recordRequest: () => {},
}));
console.log("deepseek id      :", pDeepseek.id, "available:", pDeepseek.available(), "(requires key)");

const pDemo = new ExtensibleWebSearchProvider(() => ({
	provider: "demo",
	apiKeyEnv: "DSH_WEB_SEARCH_DEMO_KEY",
	baseURL: "https://example.invalid",
	adapter: registry.get("demo"),
	settings: {},
	recordRequest: () => {},
}));
console.log("demo id          :", pDemo.id, "available:", pDemo.available());

let registered = null;
const stubCtx = {
	inject: () => () => {},
	web: { registerSearchProvider: (p) => { registered = p; return () => {}; } },
	get: () => undefined,
};
apply(stubCtx, Config({}));
console.log("apply registered :", registered?.id, "(must equal deepseek-official)");

console.log("SMOKE OK");
