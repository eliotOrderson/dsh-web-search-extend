import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebFetchProvider, WebFetchResult } from "@deepseek-ai/dsh-web";
import { makeLocalFetchProvider } from "../src/core/localFetch.js";

const fetchMock = vi.hoisted(() => vi.fn());

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.clearAllMocks();
});

let providers: WebFetchProvider[] = [];

const local = () => makeLocalFetchProvider(() => providers, fetchMock as (url: string, signal?: AbortSignal) => Promise<WebFetchResult>);

beforeEach(() => {
	providers = [];
});

describe("availability", () => {
	it("is usable when no other fetch provider is available", () => {
		const provider = local();
		providers = [provider];
		expect(provider.available()).toBe(true);
	});

	it("yields to another available provider", () => {
		const provider = local();
		const other = { id: "other", available: () => true, fetch: async () => ({ url: "", statusCode: 200, body: { kind: "text" as const, content: "" }, truncated: false }) };
		providers = [provider, other];
		expect(provider.available()).toBe(false);
	});

	it("stays usable when other providers are unavailable", () => {
		const provider = local();
		const other = { id: "other", available: () => false, fetch: async () => ({ url: "", statusCode: 200, body: { kind: "text" as const, content: "" }, truncated: false }) };
		providers = [provider, other];
		expect(provider.available()).toBe(true);
	});
});

describe("fetch", () => {
	it("passes the request through to the injected fetch implementation", async () => {
		const result: WebFetchResult = {
			url: "https://example.com/final",
			statusCode: 200,
			body: { kind: "html", content: "<html><body>hi</body></html>" },
			truncated: false,
		};
		fetchMock.mockResolvedValue(result);
		await expect(local().fetch({ url: "https://example.com/start" })).resolves.toEqual(result);
		expect(fetchMock).toHaveBeenCalledWith("https://example.com/start", undefined);
	});
});