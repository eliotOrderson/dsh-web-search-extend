/**
 * Capability derivation for adapters. Method presence IS the capability
 * declaration: a separately maintained list could drift from the code it
 * describes, so none exists. A renamed optional method silently shrinks the
 * set here — bundled adapters pin their exact sets in unit tests (spec
 * section 5) so that regression is loud.
 * @module dsh-web-search-extend/core/capabilities
 */
import type { WebAdapter, WebOperation } from "../types.js";

/**
 * The operations `adapter` can serve. `research` requires BOTH research
 * methods: submit without poll would strand requests in a non-terminal phase,
 * which is not a capability but a trap.
 */
export function capabilitiesOf(adapter: WebAdapter): ReadonlySet<WebOperation> {
	const capabilities = new Set<WebOperation>();
	if (typeof adapter.search === "function") capabilities.add("search");
	if (typeof adapter.extract === "function") capabilities.add("extract");
	if (typeof adapter.crawl === "function") capabilities.add("crawl");
	if (typeof adapter.map === "function") capabilities.add("map");
	if (typeof adapter.submitResearch === "function" && typeof adapter.pollResearch === "function") {
		capabilities.add("research");
	}
	return capabilities;
}
