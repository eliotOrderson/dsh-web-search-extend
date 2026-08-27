import { describe, expect, it } from "vitest";
import { WebError } from "@deepseek-ai/dsh-web";
import { createSecureFetch } from "../src/core/secureFetch.js";

const fakeResponse = (url: string, contentType: string, content: string) => ({
    url,
    status: 200,
    headers: new Headers({ "content-type": contentType }),
    text: async () => content,
});

describe("secureFetch", () => {
    it("blocks private IP literals before fetching", async () => {
        const fetch = async () => {
            throw new Error("should not fetch");
        };
        const lookup = async () => [];
        await expect(createSecureFetch({ fetch, lookup })("http://127.0.0.1/")).rejects.toMatchObject({
            code: "WEB_FETCH_BLOCKED",
        });
    });

    it("blocks hostnames whose DNS resolves to private addresses", async () => {
        const fetch = async () => {
            throw new Error("should not fetch");
        };
        const lookup = async () => [{ address: "10.0.0.1", family: 4 }];
        await expect(createSecureFetch({ fetch, lookup })("http://internal.example/")).rejects.toMatchObject({
            code: "WEB_FETCH_BLOCKED",
        });
    });

    it("allows the 198.18/15 fake-IP range for DNS-resolved hostnames", async () => {
        const fetch = async () => fakeResponse("https://example.com/final", "text/plain", "ok");
        const lookup = async () => [{ address: "198.18.0.1", family: 4 }];
        const result = await createSecureFetch({ fetch, lookup })("https://example.com/");
        expect(result.body).toEqual({ kind: "text", content: "ok" });
    });

    it("blocks the fake-IP range when used as an IP literal", async () => {
        const fetch = async () => {
            throw new Error("should not fetch");
        };
        const lookup = async () => [];
        await expect(createSecureFetch({ fetch, lookup })("http://198.18.0.1/")).rejects.toMatchObject({
            code: "WEB_FETCH_BLOCKED",
        });
    });

    it("blocks non-http protocols and embedded credentials", async () => {
        const fetch = async () => {
            throw new Error("should not fetch");
        };
        const lookup = async () => [];
        const secureFetch = createSecureFetch({ fetch, lookup });
        await expect(secureFetch("file:///etc/passwd")).rejects.toBeInstanceOf(WebError);
        await expect(secureFetch("http://user:pass@example.com/")).rejects.toBeInstanceOf(WebError);
    });

    it("fetches public hostnames and maps the response body", async () => {
        const fetch = async () => fakeResponse("https://example.com/final", "text/html; charset=utf-8", "<html>hi</html>");
        const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
        const result = await createSecureFetch({ fetch, lookup })("https://example.com/start");
        expect(result).toEqual({
            url: "https://example.com/final",
            statusCode: 200,
            body: { kind: "html", content: "<html>hi</html>" },
            truncated: false,
        });
    });
});