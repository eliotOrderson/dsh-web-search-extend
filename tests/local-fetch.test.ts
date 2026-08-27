import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebFetchProvider } from "@deepseek-ai/dsh-web";
import { makeLocalFetchProvider } from "../src/core/localFetch.js";

const fetchMock = vi.hoisted(() => vi.fn());

beforeEach(() => {
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

let providers: WebFetchProvider[] = [];

const local = () => makeLocalFetchProvider(() => providers);

const fakeResponse = (status: number, url: string, contentType: string, content: string) => ({
	status,
	url,
	headers: new Headers({ "content-type": contentType }),
	text: async () => content,
});

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
	it("maps an HTML response to html body kind", async () => {
		fetchMock.mockResolvedValue(fakeResponse(200, "https://example.com/final", "text/html; charset=utf-8", "<html><body>hi</body></html>"));
		const result = await local().fetch({ url: "https://example.com/start" });
		expect(result).toEqual({
			url: "https://example.com/final",
			statusCode: 200,
			body: { kind: "html", content: "<html><body>hi</body></html>" },
			truncated: false,
		});
	});

	it("maps a non-HTML response to text body kind", async () => {
		fetchMock.mockResolvedValue(fakeResponse(200, "https://example.com/robots.txt", "text/plain", "plain"));
		const result = await local().fetch({ url: "https://example.com/robots.txt" });
		expect(result.body).toEqual({ kind: "text", content: "plain" });
	});
});