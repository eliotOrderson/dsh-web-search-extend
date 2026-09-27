/**
 * Atomic JSON state file shared by the plugin's persistent tiers (provider
 * cooldown board and search-result cache). Both writers publish through one
 * document and one directory, so a single rename exposes a consistent snapshot
 * and a crash can never leave a half-written file behind.
 *
 * Dependency-free and never-throwing on purpose: state is an optimization, so a
 * read-only or absent home must degrade to memory-only rather than fail the
 * plugin. Nothing secret may ever be passed to it — only caller-supplied state
 * such as cooldown deadlines and cached results; key material belongs to the
 * credentials plane.
 * @module dsh-web-search-extend/core/state
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Plugin leaf under `<home>/state`, keeping state per plugin, not per harness. */
const STATE_DIR_NAME = "dsh-web-search-extend";
/** One JSON document per state directory; the atomic rename target. */
const STATE_FILE_NAME = "state.json";
/**
 * Process-wide latch: a single failed write turns every later write into a
 * no-op, so a read-only home costs one syscall instead of one per search.
 */
let writesDisabled = false;
/** Per-process part of the temp-file name; the pid separates the dsh instances. */
let writeCounter = 0;

export interface StateFile {
	readonly version: number;
	readonly cooldown?: unknown;
	readonly cache?: unknown;
}

/**
 * Read `$DSH_HOME` from the launch snapshot the host injects on the context.
 * The snapshot is probed structurally rather than imported so this leaf stays
 * dependency-free and still works where the slot is absent.
 */
function launchEnvironmentHome(ctx: unknown): string | undefined {
	try {
		const snapshot = (ctx as { launchEnvironment?: { get?: (name: string) => { value?: unknown } | undefined } } | undefined)
			?.launchEnvironment;
		const resolved = snapshot?.get?.("DSH_HOME")?.value;
		return typeof resolved === "string" && resolved.trim().length > 0 ? resolved : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Blank means unset, matching `resolveDshHome`: an empty override must never
 * resolve the home to the current working directory.
 */
function blankIsUnset(value: string | undefined): string | undefined {
	return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/**
 * Resolve the per-plugin state directory: the launch environment's harness home
 * (which also carries the project and user `.env` layers a bare `process.env`
 * read would miss), then `$DSH_HOME`, then the OS temp dir.
 * @param ctx - plugin context, which may expose the launcher's environment snapshot.
 * @returns an absolute state directory path; never throws.
 */
export function resolveStateDir(ctx: unknown): string {
	try {
		const home = launchEnvironmentHome(ctx) ?? blankIsUnset(process.env.DSH_HOME);
		if (home !== undefined) return join(home, "state", STATE_DIR_NAME);
		return join(tmpdir(), STATE_DIR_NAME);
	} catch {
		// Last resort keeps the contract (always a string, never a throw) even
		// when temp-dir resolution itself fails; writeState then degrades to
		// memory-only.
		return STATE_DIR_NAME;
	}
}

/**
 * Read the state document.
 * @param dir - state directory from {@link resolveStateDir}.
 * @returns the parsed document, or undefined when the file is missing, is not
 * JSON, or does not carry the versioned shape this module promises.
 */
export function readState(dir: string): StateFile | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(dir, STATE_FILE_NAME), "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
		const { version } = parsed as { version?: unknown };
		return typeof version === "number" ? (parsed as StateFile) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Publish the state document atomically: write a uniquely named temp file,
 * then rename it over the target, so a reader sees either the old or the new
 * document. The temp name carries the pid and a per-process counter because two
 * dsh instances can share one state directory (one harness home, two profiles):
 * a fixed `<file>.tmp` would let them interleave into a mixed document.
 * @param dir - state directory; created recursively when absent.
 * @param state - caller-supplied state, which must never carry key material.
 */
export function writeState(dir: string, state: StateFile): void {
	if (writesDisabled) return;
	let temp: string | undefined;
	try {
		mkdirSync(dir, { recursive: true });
		const target = join(dir, STATE_FILE_NAME);
		temp = `${target}.${process.pid}.${writeCounter}.tmp`;
		writeCounter += 1;
		writeFileSync(temp, JSON.stringify(state), "utf8");
		renameSync(temp, target);
	} catch {
		writesDisabled = true;
	} finally {
		if (temp !== undefined) {
			try {
				// A successful rename already moved it; a failed one must not
				// leave litter behind.
				rmSync(temp, { force: true });
			} catch {
				// Cleanup failing is not worth a throw from a never-throwing writer.
			}
		}
	}
}
