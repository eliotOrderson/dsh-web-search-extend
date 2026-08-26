import { describe, expect, it, vi } from "vitest";
import { WebError } from "@deepseek-ai/dsh-web";
import { isKeyError, rotatingKey, type WithKeyIndex } from "../src/core/rotating-key.js";
import type { SearchAdapter } from "../src/types.js";

function keyedAdapter(over: { search?: (apiKey: string | undefined) => Promise<unknown> } = {}): SearchAdapter {
	return {
		id: "vendor",
		label: "vendor",
		requiresApiKey: false,
		defaultApiKeyEnv: "VENDOR_API_KEY",
		baseURLEnv: "VENDOR_BASE_URL",
		defaultBaseURL: "https://vendor.test",
		available: () => true,
		search: (request, runtime) => Promise.resolve(over.search?.(runtime.apiKey) ?? { sources: [], truncated: false }),
	} as SearchAdapter;
}

const authError = () => new WebError("Unauthorized: invalid API key (HTTP 401)", "WEB_PROVIDER_ERROR");
const networkError = () => new WebError("DeepSeek search request failed: TypeError: socket hung up", "WEB_PROVIDER_ERROR");

const runtimeOf = (adapter: SearchAdapter, apiKey?: string) => ({
	apiKey,
	apiKeyEnv: adapter.defaultApiKeyEnv,
	baseURL: adapter.defaultBaseURL,
	settings: {},
});

describe("key-error classification", () => {
	it("accepts auth / quota / rate-limit provider errors", () => {
		expect(isKeyError(authError())).toBe(true);
		expect(isKeyError(new WebError("quota exhausted (HTTP 402)", "WEB_PROVIDER_ERROR"))).toBe(true);
		expect(isKeyError(new WebError("rate limit surpassed", "WEB_PROVIDER_ERROR"))).toBe(true);
	});

	it("rejects non-key failures and other codes", () => {
		expect(isKeyError(networkError())).toBe(false);
		expect(isKeyError(new WebError("Search aborted", "WEB_ABORTED"))).toBe(false);
		expect(isKeyError(new Error("unauthorized"))).toBe(false);
	});
});

describe("rotation over a comma-separated key source", () => {
	it("rotates to the second key when the first 401s and serves with it", async () => {
		const seenKeys: (string | undefined)[] = [];
		const onKeyIndex = vi.fn();
		const adapter = rotatingKey(
			keyedAdapter({
				search: async (apiKey) => {
					seenKeys.push(apiKey);
					if (apiKey === "k1") throw authError();
					return { sources: [{ url: "https://vendor.test/ok" }], truncated: false };
				},
			}),
			{ onKeyIndex },
		);
		await expect(adapter.search({ query: "q" }, runtimeOf(adapter, "k1,k2"))).resolves.toEqual({
			sources: [{ url: "https://vendor.test/ok" }],
			truncated: false,
		});
		expect(seenKeys).toEqual(["k1", "k2"]);
		expect(onKeyIndex).toHaveBeenLastCalledWith(1);
	});

	it("never rotates on non-key failures — the original error escapes untouched", async () => {
		const inner = keyedAdapter({ search: () => Promise.reject(networkError()) });
		await expect(rotatingKey(inner).search({ query: "q" }, runtimeOf(inner, "k1,k2"))).rejects.toMatchObject({
			message: networkError().message,
		});
	});

	it("rethrows the ORIGINAL last error after exhausting every key, index attached", async () => {
		const last = authError();
		const inner = keyedAdapter({ search: () => Promise.reject(last) });
		const error = await rotatingKey(inner)
			.search({ query: "q" }, runtimeOf(inner, "k1, k2,,k3"))
			.catch((e: unknown) => e);
		expect(error).toBe(last);
		expect((error as WithKeyIndex).keyIndex).toBe(2);
	});

	it("passes through keyless and single-key runtimes without wrapping behavior", async () => {
		const innerSearch = vi.fn(() => Promise.resolve({ sources: [], truncated: false }));
		const wrapper = rotatingKey(keyedAdapter({ search: innerSearch }));
		await wrapper.search({ query: "q" }, runtimeOf(wrapper));
		await wrapper.search({ query: "q" }, runtimeOf(wrapper, "solo"));
		expect(innerSearch).toHaveBeenCalledTimes(2);
	});
});
