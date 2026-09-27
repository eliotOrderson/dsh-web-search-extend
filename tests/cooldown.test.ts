import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { WebError } from "@deepseek-ai/dsh-web";
import {
	CooldownBoard,
	DEFAULT_COOLDOWN_BASE_MS,
	DEFAULT_COOLDOWN_CAP_MS,
	isQuotaError,
	loadBoard,
	saveBoard,
} from "../src/core/cooldown.js";

const scratch: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-search-extend-cooldown-"));
	scratch.push(dir);
	return dir;
}

function writeDocument(dir: string, document: unknown): void {
	fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(document), "utf8");
}

afterAll(() => {
	for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

const quotaError = () => new WebError("Firecrawl keyless monthly credit quota exhausted (HTTP 402)", "WEB_PROVIDER_ERROR");
const rateLimitError = () => new WebError("Tavily keyless rate limit reached", "WEB_PROVIDER_ERROR");
const networkError = () => new WebError("DeepSeek search request failed: TypeError: socket hung up", "WEB_PROVIDER_ERROR");

describe("quota classification (chain switchable set, captain ruling)", () => {
	it("accepts every WEB_PROVIDER_ERROR: quota, rate limit, 402/429, 5xx, network", () => {
		expect(isQuotaError(quotaError())).toBe(true);
		expect(isQuotaError(rateLimitError())).toBe(true);
		expect(isQuotaError(new WebError("HTTP 429 too many requests", "WEB_PROVIDER_ERROR"))).toBe(true);
		expect(isQuotaError(new WebError("upstream exploded (HTTP 500)", "WEB_PROVIDER_ERROR"))).toBe(true);
		expect(isQuotaError(networkError())).toBe(true);
	});

	it("rejects credential-missing, cancellation, other codes, and non-WebErrors", () => {
		expect(isQuotaError(new WebError("no key", "WEB_PROVIDER_CREDENTIAL_MISSING"))).toBe(false);
		expect(isQuotaError(new WebError("Search aborted", "WEB_ABORTED"))).toBe(false);
		expect(isQuotaError(new Error("quota"))).toBe(false);
	});
});

describe("exponential backoff schedule (fake clock)", () => {
	it("doubles the window per consecutive failure and caps it", () => {
		let now = 0;
		const board = new CooldownBoard({ clock: () => now });
		const id = "firecrawl-keyless";

		now = 1_000;
		expect(board.isCooling(id)).toBe(false);
		expect(board.onQuotaError(id)).toBe(1_000 + DEFAULT_COOLDOWN_BASE_MS);
		expect(board.coolingUntil(id)).toBe(61_000);

		now = 61_000;
		expect(board.isCooling(id)).toBe(false);
		expect(board.onQuotaError(id)).toBe(61_000 + 2 * DEFAULT_COOLDOWN_BASE_MS);

		now = 181_000;
		expect(board.onQuotaError(id)).toBe(181_000 + 4 * DEFAULT_COOLDOWN_BASE_MS);
		expect(board.onQuotaError(id)).toBe(181_000 + 8 * DEFAULT_COOLDOWN_BASE_MS);
		expect(board.isCooling(id)).toBe(true);

		let lastUntil = 0;
		for (let round = 0; round < 10; round += 1) lastUntil = board.onQuotaError(id);
		expect(lastUntil - now).toBe(DEFAULT_COOLDOWN_CAP_MS);
	});

	it("expires windows by clock passage without touching counters", () => {
		let now = 0;
		const board = new CooldownBoard({ clock: () => now });
		board.onQuotaError("a");
		now = DEFAULT_COOLDOWN_BASE_MS;
		expect(board.isCooling("a")).toBe(false);
	});

	it("tracks adapter ids independently", () => {
		const board = new CooldownBoard({ clock: () => 0 });
		board.onQuotaError("a");
		expect(board.isCooling("a")).toBe(true);
		expect(board.isCooling("b")).toBe(false);
	});
});

describe("reset on success", () => {
	it("clears the failure count so the next error starts back at base", () => {
		let now = 0;
		const board = new CooldownBoard({ clock: () => now });
		board.onQuotaError("a");
		board.onQuotaError("a");
		expect(board.onQuotaError("a") - now).toBe(4 * DEFAULT_COOLDOWN_BASE_MS);

		now = 999_999_999;
		board.onSuccess("a");
		now += 1_000;
		expect(board.onQuotaError("a") - now).toBe(DEFAULT_COOLDOWN_BASE_MS);
	});

	it("success also ends an active cooldown window immediately", () => {
		const board = new CooldownBoard({ clock: () => 0 });
		board.onQuotaError("a");
		expect(board.isCooling("a")).toBe(true);
		board.onSuccess("a");
		expect(board.isCooling("a")).toBe(false);
		expect(board.coolingUntil("a")).toBeUndefined();
	});
});

describe("persistence through the shared state file", () => {
	it("round-trips the failure streak and the window", () => {
		const dir = tempDir();
		const now = 1_000;
		const board = new CooldownBoard({ clock: () => now });
		board.onQuotaError("server-delay", 5_000);
		board.onQuotaError("estimate");
		saveBoard(dir, board);

		const restored = loadBoard(dir, { clock: () => now });
		expect(restored.coolingUntil("server-delay")).toBe(6_000);
		expect(restored.coolingUntil("estimate")).toBe(1_000 + DEFAULT_COOLDOWN_BASE_MS);
		expect(restored.toState()).toEqual(board.toState());
	});

	it("carries the streak across a restart so the next window keeps doubling", () => {
		const dir = tempDir();
		let now = 0;
		const board = new CooldownBoard({ clock: () => now });
		board.onQuotaError("a");
		board.onQuotaError("a");
		saveBoard(dir, board);

		// A restart happens long after that window expired: the window is stale,
		// the streak is not.
		now = 10 * DEFAULT_COOLDOWN_CAP_MS;
		const restored = loadBoard(dir, { clock: () => now });
		expect(restored.isCooling("a")).toBe(false);
		expect(restored.onQuotaError("a")).toBe(now + 4 * DEFAULT_COOLDOWN_BASE_MS);
	});

	it("drops a window that reaches further out than the cap", () => {
		const dir = tempDir();
		writeDocument(dir, { version: 1, cooldown: { adapters: { a: { failures: 2, until: 10 * DEFAULT_COOLDOWN_CAP_MS } } } });

		const restored = loadBoard(dir, { clock: () => 0 });
		expect(restored.isCooling("a")).toBe(false);
		expect(restored.onQuotaError("a")).toBe(4 * DEFAULT_COOLDOWN_BASE_MS);
	});

	it("starts cold for a missing, corrupt, or unrecognizable document", () => {
		const cold = { adapters: {} };
		expect(loadBoard(tempDir(), { clock: () => 0 }).toState()).toEqual(cold);

		const corrupt = tempDir();
		fs.writeFileSync(path.join(corrupt, "state.json"), "{not json", "utf8");
		expect(loadBoard(corrupt, { clock: () => 0 }).toState()).toEqual(cold);

		const wrongShape = tempDir();
		writeDocument(wrongShape, { version: 1, cooldown: { adapters: { a: { failures: "3", until: 5_000 }, b: 7 } } });
		expect(loadBoard(wrongShape, { clock: () => 0 }).toState()).toEqual(cold);

		const otherTierOnly = tempDir();
		writeDocument(otherTierOnly, { version: 1, cache: { hits: 1 } });
		expect(loadBoard(otherTierOnly, { clock: () => 0 }).toState()).toEqual(cold);
	});

	it("preserves the document version and the other tier's keys", () => {
		const dir = tempDir();
		writeDocument(dir, { version: 3, cache: { hits: ["x"] } });
		const board = new CooldownBoard({ clock: () => 0 });
		board.onQuotaError("a");
		saveBoard(dir, board);

		expect(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"))).toEqual({
			version: 3,
			cache: { hits: ["x"] },
			cooldown: { adapters: { a: { failures: 1, until: DEFAULT_COOLDOWN_BASE_MS } } },
		});
	});

	it("does not change the live decision for a running process", () => {
		const dir = tempDir();
		let now = 5_000;
		const board = new CooldownBoard({ clock: () => now });
		board.onQuotaError("a", 30_000);
		saveBoard(dir, board);

		now = 15_000;
		const restored = loadBoard(dir, { clock: () => now });
		expect(restored.isCooling("a")).toBe(board.isCooling("a"));
		expect(restored.coolingUntil("a")).toBe(board.coolingUntil("a"));
		now = 35_000;
		expect(restored.isCooling("a")).toBe(false);
	});

	it("publishes a document another process reads back", () => {
		const dir = tempDir();
		const board = new CooldownBoard({ clock: () => 1_000 });
		board.onQuotaError("tavily", 5_000);
		saveBoard(dir, board);

		const script = "const fs=require('node:fs');const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(JSON.stringify(s.cooldown));";
		const child = spawnSync(process.execPath, ["-e", script, path.join(dir, "state.json")], { encoding: "utf8" });
		expect(child.status).toBe(0);
		expect(JSON.parse(child.stdout)).toEqual({ adapters: { tavily: { failures: 1, until: 6_000 } } });
	});

	it("restores a document written by another process", () => {
		const dir = tempDir();
		const until = Date.now() + 60_000;
		const script = `const fs=require('node:fs');fs.writeFileSync(process.argv[1],JSON.stringify({version:2,cooldown:{adapters:{tavily:{failures:2,until:${until}}}}}));`;
		const child = spawnSync(process.execPath, ["-e", script, path.join(dir, "state.json")], { encoding: "utf8" });
		expect(child.status).toBe(0);

		const now = Date.now();
		const restored = loadBoard(dir, { clock: () => now });
		expect(restored.isCooling("tavily")).toBe(true);
		expect(restored.onQuotaError("tavily")).toBe(now + 4 * DEFAULT_COOLDOWN_BASE_MS);
	});
});
