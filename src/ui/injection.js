import { PROVIDER_MARKER, PARAMS_MARKER, DEFAULT_PROVIDER, FIELD_SPECS } from "./config.js";
import { findBody, hideCoreField } from "./dom.js";
import { buildProviderSelect, buildRouteModeSelect, buildParamFields } from "./controls.js";
import { createTranslator } from "./i18n.js";

function hideOfficialBadge(body) {
	const badges = body.querySelector(".At1oFq_badges");
	if (badges) badges.style.display = "none";
}

function syncParams(settings) {
	const active = settings.readProvider(DEFAULT_PROVIDER);
	const container = document.querySelector(`[${PARAMS_MARKER}]`);
	if (container) {
		for (const field of container.querySelectorAll("[data-wse-for]")) {
			field.style.display = field.getAttribute("data-wse-for") === active ? "" : "none";
		}
	}
	const providerSelect = document.querySelector(`[${PROVIDER_MARKER}] select`);
	if (providerSelect) providerSelect.value = active;
}

function refreshParamValues(settings) {
	for (const field of document.querySelectorAll("[data-wse-param]")) {
		const [section, key] = field.getAttribute("data-wse-param").split(".");
		const spec = (FIELD_SPECS[section] ?? []).find((s) => s.key === key);
		if (!spec) continue;
		const value = settings.readSection(section)[key];
		const shown = value === undefined || value === null ? spec.default : value;
		const control = field.querySelector("select, input[type=checkbox], input:not([type=checkbox])") ?? field.querySelector("input, select");
		if (!control) continue;
		if (spec.type === "bool") control.checked = Boolean(shown);
		else control.value = String(shown);
	}
}

function teardownInjected() {
	for (const el of document.querySelectorAll(`[${PROVIDER_MARKER}],[${PARAMS_MARKER}]`)) el.remove();
}

function debounce(fn, ms) {
	let timer;
	return () => {
		clearTimeout(timer);
		timer = setTimeout(fn, ms);
	};
}

export function startCard({ ctx, settings }) {
	const translate = createTranslator(ctx.locale);

	const inject = () => {
		const body = findBody();
		if (!body) return;

		hideCoreField("plugin-config-web-search-endpoint");
		hideCoreField("plugin-config-web-search-max-uses");

		// Insert provider first, THEN the toggle - each lands at firstChild,
		// so final order is [fallback toggle, provider select, ...params].
		if (!body.querySelector(`[${PROVIDER_MARKER}]`)) {
			body.insertBefore(buildProviderSelect({
				settings,
				translate,
				onProviderChange: (provider) => {
					if (settings.setProvider(provider)) {
						syncParams(settings);
					}
				},
			}), body.firstChild);
		}
		if (!body.querySelector(`[data-wse-route]`)) {
			body.insertBefore(buildRouteModeSelect({ settings, translate }), body.firstChild);
		}
		let container = body.querySelector(`[${PARAMS_MARKER}]`);
		if (!container) {
			container = document.createElement("div");
			container.setAttribute(PARAMS_MARKER, "");
			const providerSelect = body.querySelector(`[${PROVIDER_MARKER}]`);
			if (providerSelect && providerSelect.nextSibling) {
				body.insertBefore(container, providerSelect.nextSibling);
			} else {
				body.appendChild(container);
			}
			buildParamFields(container, { settings, translate });
		}

		syncParams(settings);
		refreshParamValues(settings);
		hideOfficialBadge(body);
	};

	inject();

	new MutationObserver(debounce(inject, 150)).observe(document.body, { childList: true, subtree: true });

	try {
		settings.subscribe(() => { syncParams(settings); refreshParamValues(settings); });
	} catch { /* best-effort */ }

	try {
		ctx.locale?.subscribe?.(() => {
			teardownInjected();
			inject();
		});
	} catch { /* best-effort */ }
}
