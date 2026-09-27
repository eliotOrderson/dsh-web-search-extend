import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readState, resolveStateDir, writeState } from "../src/core/state.js";

const scratch: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-web-search-extend-state-"));
	scratch.push(dir);
	return dir;
}

afterEach(() => {
	vi.unstubAllEnvs();
});

afterAll(() => {
	for (const dir of scratch) {
		if (!fs.existsSync(dir)) continue;
		// Undo any read-only mode so the recursive removal can descend.
		fs.chmodSync(dir, 0o700);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

const homeDir = (home: string) => path.join(home, "state", "dsh-web-search-extend");

describe("resolveStateDir", () => {
	it("prefers the harness home the launch environment snapshot exposes", () => {
		vi.stubEnv("DSH_HOME", "/env/home");
		const ctx = { launchEnvironment: { get: (name: string) => (name === "DSH_HOME" ? { value: "/launch/home" } : undefined) } };
		expect(resolveStateDir(ctx)).toBe(homeDir("/launch/home"));
	});

	it("falls back to $DSH_HOME when the context exposes no snapshot", () => {
		vi.stubEnv("DSH_HOME", "/env/home");
		expect(resolveStateDir({})).toBe(homeDir("/env/home"));
		expect(resolveStateDir(undefined)).toBe(homeDir("/env/home"));
	});

	it("treats a blank $DSH_HOME as unset instead of resolving it against the cwd", () => {
		vi.stubEnv("DSH_HOME", "   ");
		expect(resolveStateDir({})).toBe(path.join(os.tmpdir(), "dsh-web-search-extend"));
		vi.stubEnv("DSH_HOME", undefined);
		expect(resolveStateDir(null)).toBe(path.join(os.tmpdir(), "dsh-web-search-extend"));
	});

	it("never throws on a hostile or malformed context", () => {
		vi.stubEnv("DSH_HOME", undefined);
		const throwingGet = {
			launchEnvironment: {
				get: () => {
					throw new Error("snapshot exploded");
				},
			},
		};
		const throwingSlot = Object.defineProperty({}, "launchEnvironment", {
			get: () => {
				throw new Error("slot exploded");
			},
		});
		for (const ctx of [throwingGet, throwingSlot, 42, "ctx", []]) {
			expect(() => resolveStateDir(ctx)).not.toThrow();
			expect(resolveStateDir(ctx)).toBe(path.join(os.tmpdir(), "dsh-web-search-extend"));
		}
	});
});

describe("readState", () => {
	it("returns undefined for a missing file", () => {
		expect(readState(tempDir())).toBeUndefined();
	});

	it("returns undefined for a corrupt or non-document file", () => {
		const dir = tempDir();
		const file = path.join(dir, "state.json");
		for (const body of ['{"version":', "not json at all", "", "[1,2]", "42", "null"]) {
			fs.writeFileSync(file, body, "utf8");
			expect(readState(dir)).toBeUndefined();
		}
	});

	it("returns undefined for a document without the versioned shape", () => {
		const dir = tempDir();
		fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ cooldown: { a: 1 } }), "utf8");
		expect(readState(dir)).toBeUndefined();
	});

	it("returns the parsed document, sub-objects included", () => {
		const dir = tempDir();
		const state = { version: 3, cooldown: { firecrawl: 1_700_000_000_000 }, cache: { hits: ["a"] } };
		fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state), "utf8");
		expect(readState(dir)).toEqual(state);
	});
});

describe("writeState", () => {
	it("creates missing directories and round-trips through state.json", () => {
		const dir = path.join(tempDir(), "nested", "deeper");
		const state = { version: 1, cooldown: { tavily: 1_700_000_000_000 } };
		writeState(dir, state);

		expect(fs.readFileSync(path.join(dir, "state.json"), "utf8")).toBe(JSON.stringify(state));
		expect(readState(dir)).toEqual(state);
	});

	it("publishes atomically, leaving no .tmp sibling behind", () => {
		const dir = tempDir();
		writeState(dir, { version: 1, cache: { first: true } });
		expect(fs.readdirSync(dir)).toEqual(["state.json"]);
	});

	it("replaces the previous document on the next write", () => {
		const dir = tempDir();
		writeState(dir, { version: 1, cache: { generation: 1 } });
		writeState(dir, { version: 2, cache: { generation: 2 } });
		expect(readState(dir)).toEqual({ version: 2, cache: { generation: 2 } });
		expect(fs.readdirSync(dir)).toEqual(["state.json"]);
	});

	it("keeps state.json whole across repeated writes and leaves foreign temp files alone", () => {
		const dir = tempDir();
		// Temp files a crashed writer or a second dsh instance left behind: the
		// old fixed name must never be reused, or the two writers would interleave.
		fs.writeFileSync(path.join(dir, "state.json.tmp"), "{ half written", "utf8");
		fs.writeFileSync(path.join(dir, "state.json.stray.tmp"), "{", "utf8");

		writeState(dir, { version: 1, cache: { writer: "first" } });
		writeState(dir, { version: 1, cache: { writer: "second" } });

		expect(JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"))).toEqual({ version: 1, cache: { writer: "second" } });
		expect(readState(dir)).toEqual({ version: 1, cache: { writer: "second" } });
		expect(fs.readFileSync(path.join(dir, "state.json.tmp"), "utf8")).toBe("{ half written");
		expect(fs.readdirSync(dir).sort()).toEqual(["state.json", "state.json.stray.tmp", "state.json.tmp"]);
	});
});

describe("writeState degradation (module latch, so each case re-imports)", () => {
	async function freshState() {
		vi.resetModules();
		return await import("../src/core/state.js");
	}

	// chmod cannot deny a root process, so the read-only case is reported as
	// skipped rather than passing without exercising the failure path.
	it.skipIf(process.getuid?.() === 0)("disables further writes after a read-only directory denies the temp file", async () => {
		const { readState: read, writeState: write } = await freshState();
		const root = tempDir();
		const readOnly = path.join(root, "state");
		fs.mkdirSync(readOnly, { recursive: true });
		fs.chmodSync(readOnly, 0o500);
		try {
			expect(() => write(readOnly, { version: 1 })).not.toThrow();
			expect(fs.existsSync(path.join(readOnly, "state.json"))).toBe(false);
			expect(read(readOnly)).toBeUndefined();

			// The latch: even a writable target stays untouched afterwards.
			const writable = path.join(root, "writable");
			write(writable, { version: 1 });
			expect(fs.existsSync(path.join(writable, "state.json"))).toBe(false);
		} finally {
			fs.chmodSync(readOnly, 0o700);
		}
	});

	it("never throws on an unusable target and latches writes off", async () => {
		const { writeState: write } = await freshState();
		const root = tempDir();
		const blocker = path.join(root, "state.json");
		fs.writeFileSync(blocker, "not a directory", "utf8");

		expect(() => write(path.join(blocker, "child"), { version: 1 })).not.toThrow();
		const later = path.join(root, "later");
		write(later, { version: 1 });
		expect(fs.existsSync(path.join(later, "state.json"))).toBe(false);
	});

	it("removes its own temp file when the rename cannot publish", async () => {
		const { writeState: write } = await freshState();
		const dir = path.join(tempDir(), "state");
		// The target is a non-empty directory, so the rename fails after the temp
		// file was written: the temp must not survive as litter.
		fs.mkdirSync(path.join(dir, "state.json", "occupied"), { recursive: true });

		expect(() => write(dir, { version: 1 })).not.toThrow();
		expect(fs.readdirSync(dir)).toEqual(["state.json"]);
	});
});
