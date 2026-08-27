/**
 * Secure local fetch for the composite tier. Uses undici with a custom DNS
 * lookup that validates every resolved address before the socket connects,
 * which closes DNS-rebinding and SSRF (private/reserved/cloud-metadata) holes.
 * @module dsh-web-search-extend/core/secureFetch
 */
import { Agent, fetch as undiciFetch } from "undici";
import { lookup as dnsLookup } from "node:dns/promises";
import { type LookupAddress, type LookupOptions } from "node:dns";
import ipaddr from "ipaddr.js";
import { WebError, type WebFetchResult } from "@deepseek-ai/dsh-web";

const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

const BLOCKED_RANGES = new Set([
    "broadcast",
    "carrierGradeNat",
    "linkLocal",
    "loopback",
    "multicast",
    "private",
    "reserved",
    "uniqueLocal",
    "unspecified",
]);

function isFakeIp(address: string): boolean {
    const parsed = ipaddr.parse(address);
    if (!(parsed instanceof ipaddr.IPv4)) return false;
    return parsed.octets[0] === 198 && (parsed.octets[1] === 18 || parsed.octets[1] === 19);
}

function isBlocked(address: string, allowFakeIp = false): boolean {
    if (allowFakeIp && isFakeIp(address)) return false;
    const parsed = ipaddr.parse(address);
    if (parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()) return BLOCKED_RANGES.has(parsed.toIPv4Address().range());
    return BLOCKED_RANGES.has(parsed.range());
}

interface SecureFetchResponse {
    url: string;
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
}

type SecureFetch = (url: string, init: {
    dispatcher?: unknown;
    redirect?: "follow" | "manual" | "error";
    signal?: AbortSignal;
}) => Promise<SecureFetchResponse>;

type SecureLookup = (hostname: string, options: LookupOptions) => Promise<LookupAddress[]>;

function createSecureLookup(lookup: SecureLookup) {
    return (
        hostname: string,
        options: LookupOptions,
        callback: (error: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void,
    ): void => {
        lookup(hostname, { all: true, verbatim: true }).then((addresses) => {
            const family = options.family;
            const allowed = addresses.filter(
                (address) => (family === undefined || family === 0 || address.family === family) && !isBlocked(address.address, true),
            );
            if (allowed.length === 0) {
                callback(new Error(`Blocked private/reserved address for ${hostname}`) as NodeJS.ErrnoException);
                return;
            }
            if (options.all) {
                callback(null, allowed);
                return;
            }
            const first = allowed[0];
            if (first === undefined) {
                callback(new Error(`Blocked private/reserved address for ${hostname}`) as NodeJS.ErrnoException);
                return;
            }
            callback(null, first.address, first.family);
        }).catch((error: NodeJS.ErrnoException) => callback(error));
    };
}

export interface SecureFetchDeps {
    fetch?: SecureFetch;
    lookup?: SecureLookup;
}

export function createSecureFetch(deps: SecureFetchDeps = {}): (url: string, signal?: AbortSignal) => Promise<WebFetchResult> {
    const fetchImpl: SecureFetch = (deps.fetch ?? undiciFetch) as SecureFetch;
    const lookupImpl: SecureLookup = (deps.lookup ?? dnsLookup) as SecureLookup;
    const agent = new Agent({
        connect: {
            lookup: createSecureLookup(lookupImpl) as any,
        },
        maxResponseSize: MAX_RESPONSE_SIZE,
    });
    return async function secureFetch(url: string, signal?: AbortSignal): Promise<WebFetchResult> {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new WebError(`Invalid URL: ${url}`, "WEB_FETCH_INVALID_URL");
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new WebError(`Unsupported protocol: ${parsed.protocol}`, "WEB_FETCH_INVALID_URL");
        }
        if (parsed.username !== "" || parsed.password !== "") {
            throw new WebError("URL must not embed credentials", "WEB_FETCH_INVALID_URL");
        }
        if (ipaddr.isValid(parsed.hostname) && isBlocked(parsed.hostname)) {
            throw new WebError(`Blocked address: ${parsed.hostname}`, "WEB_FETCH_BLOCKED");
        }
        if (!ipaddr.isValid(parsed.hostname)) {
            const addresses = await lookupImpl(parsed.hostname, { all: true, verbatim: true });
            if (!addresses.some((address) => !isBlocked(address.address, true))) {
                throw new WebError(`Blocked address for ${parsed.hostname}`, "WEB_FETCH_BLOCKED");
            }
        }
        const response = await fetchImpl(url, { dispatcher: agent, redirect: "follow", signal });
        const contentType = response.headers.get("content-type") ?? "";
        const content = await response.text();
        return {
            url: response.url || url,
            statusCode: response.status,
            body: /\bhtml\b/i.test(contentType) ? { kind: "html", content } : { kind: "text", content },
            truncated: false,
        };
    };
}

export const secureFetch = createSecureFetch();