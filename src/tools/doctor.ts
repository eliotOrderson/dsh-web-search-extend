/**
 * The model-facing `web_doctor` tool (Step 4). An OFFLINE readiness report —
 * zero network, zero quota: it inspects registry metadata, credential-ref
 * RESOLUTION (booleans only, never values), endpoint sources, cooldown state,
 * availability verdicts, and the resolved effective failover chain. The
 * report builder is a pure function over injected dependencies so tests can
 * pin the output (including the nothing-key-like guarantee) hermetically.
 * @module dsh-web-search-extend/tools/doctor
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import type { Context } from "@deepseek-ai/cordis";
import type { AdapterRegistry } from "../core/registry.js";
import type { CooldownBoard } from "../core/cooldown.js";
import { resolveChain } from "../core/chain.js";
import { DEFAULT_API_KEY_ENV, type ConfigType } from "../config.js";
import type { SearchAdapter } from "../types.js";

/** Everything the report builder needs; all injectable, none of it ctx. */
export interface DoctorDeps {
	readonly registry: AdapterRegistry;
	readonly config: ConfigType;
	/** Launching-environment lookup for an adapter's `baseURLEnv`. */
	readonly envLookup: (name: string) => string | undefined;
	/** Whether a credential-ref name resolves to a non-empty value. */
	readonly refResolves: (refName: string) => Promise<boolean>;
	readonly cooldowns: CooldownBoard | undefined;
}

export interface DoctorAdapterReport {
	readonly id: string;
	readonly label: string;
	readonly requiresApiKey: boolean;
	readonly credentialRef: string;
	readonly credentialResolves: boolean;
	readonly baseURLSource: "config" | "env" | "default";
	readonly baseURL: string;
	readonly available: boolean;
	/** ISO timestamp while cooling, undefined otherwise. */
	readonly coolingUntil: string | undefined;
	readonly chainRole: "primary" | "fallback" | "standby";
}

export interface DoctorReport {
	readonly provider: string;
	readonly effectiveChain: readonly string[];
	readonly problems: readonly string[];
	readonly adapters: readonly DoctorAdapterReport[];
}

/** Mirrors resolveOptions' key-ref ladder so the doctor reports what WOULD be used. */
function activeRefFor(config: ConfigType, adapter: SearchAdapter): string {
	const subsection = (config as Record<string, unknown>)[adapter.id] as { apiKeyEnv?: string } | undefined;
	return config.apiKeyEnv ?? subsection?.apiKeyEnv ?? adapter.defaultApiKeyEnv ?? DEFAULT_API_KEY_ENV;
}

/** Mirrors resolveOptions' baseURL ladder, per adapter, with its source labeled. */
function baseURLFor(config: ConfigType, adapter: SearchAdapter, deps: DoctorDeps): { source: DoctorAdapterReport["baseURLSource"]; url: string } {
	if (config.baseURL != null && config.baseURL.length > 0) return { source: "config", url: config.baseURL };
	const ambient = deps.envLookup(adapter.baseURLEnv);
	if (ambient !== undefined && ambient.length > 0) return { source: "env", url: ambient };
	return { source: "default", url: adapter.defaultBaseURL };
}

/** Build the structured offline report. Never touches the network or quota. */
export async function buildDoctorReport(deps: DoctorDeps): Promise<DoctorReport> {
	const { config } = deps;
	const chain = resolveChain(deps.registry, config.provider, config.fallbacks ?? []);
	const roles = new Map<string, DoctorAdapterReport["chainRole"]>();
	chain.members.forEach((member, index) => roles.set(member.id, index === 0 ? "primary" : "fallback"));
	const adapters: DoctorAdapterReport[] = [];
	for (const adapter of deps.registry.list()) {
		const refName = activeRefFor(config, adapter);
		const endpoint = baseURLFor(config, adapter, deps);
		adapters.push({
			id: adapter.id,
			label: adapter.label,
			requiresApiKey: adapter.requiresApiKey,
			credentialRef: refName,
			credentialResolves: await deps.refResolves(refName),
			baseURLSource: endpoint.source,
			baseURL: endpoint.url,
			available: adapter.available({
				apiKeyEnv: refName,
				baseURL: endpoint.url,
				settings: { ...((config as Record<string, unknown>)[adapter.id] as Record<string, unknown> | undefined), limits: config.limits },
			}),
			coolingUntil: deps.cooldowns?.coolingUntil(adapter.id) !== undefined ? new Date(deps.cooldowns!.coolingUntil(adapter.id)!).toISOString() : undefined,
			chainRole: roles.get(adapter.id) ?? "standby",
		});
	}
	return {
		provider: config.provider,
		effectiveChain: chain.members.map((member) => member.id),
		problems: [...chain.problems],
		adapters,
	};
}

/** Render the structured report as bounded text; booleans only, never secrets. */
export function renderDoctorReport(report: DoctorReport): string {
	const lines: string[] = [
		"web-search-extend doctor (offline report; no network, no quota)",
		`provider: ${report.provider}`,
		`effective chain: ${report.effectiveChain.length > 0 ? report.effectiveChain.join(" -> ") : "(none)"}`,
	];
	if (report.problems.length > 0) lines.push(`chain problems: ${report.problems.join("; ")}`);
	lines.push("adapters:");
	for (const adapter of report.adapters) {
		lines.push(
			[
				`- ${adapter.id} (${adapter.label})`,
				`  role: ${adapter.chainRole}`,
				`  requiresApiKey: ${adapter.requiresApiKey}`,
				`  credential ${adapter.credentialRef} resolves: ${adapter.credentialResolves}`,
				`  baseURL: ${adapter.baseURLSource} (${adapter.baseURL})`,
				`  available: ${adapter.available}`,
				`  cooldown: ${adapter.coolingUntil ?? "clear"}`,
			].join("\n"),
		);
	}
	return lines.join("\n");
}

/**
 * Register `web_doctor`, gated by `config.tools.doctor`. The credential
 * resolver mirrors resolveOptions' ladder (credentials service -> launching
 * environment -> process.env) but reduces every source to a boolean.
 */
export function applyDoctorTool(ctx: Context, wiring: { registry: AdapterRegistry; config: () => ConfigType; cooldowns: CooldownBoard | undefined }, options: { enabled: boolean }): void {
	if (!options.enabled) return;
	const refResolves = async (refName: string): Promise<boolean> => {
		const credentials = ctx.get("credentials");
		if (credentials !== undefined) {
			const resolved = await credentials.resolve(credentialRef(refName));
			if (resolved?.value !== undefined && resolved.value.length > 0) return true;
		}
		const ambient = launchEnvironmentOf(ctx).get(refName);
		if (ambient !== undefined && ambient.value.length > 0) return true;
		const envKey = process.env[refName];
		return envKey !== undefined && envKey.length > 0;
	};
	ctx.tools.register(defineTool({
		name: "web_doctor",
		description:
			"Offline web-search diagnostics: list every registered search engine with its key-reference status (booleans only, never secret values), endpoint source, cooldown window, availability verdict, and the effective failover chain. Zero network, zero quota.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: { type: "string", required: true } },
			},
			render: (_args, value) => [{ type: "text", text: value.text }],
		},
		isConcurrencySafe: () => true,
		async execute() {
			const report = await buildDoctorReport({
				registry: wiring.registry,
				config: wiring.config(),
				envLookup: (name) => launchEnvironmentOf(ctx).get(name)?.value,
				refResolves,
				cooldowns: wiring.cooldowns,
			});
			return { text: renderDoctorReport(report) };
		},
	}));
}
