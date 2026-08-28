import { PROVIDER_MARKER, PROVIDERS, DEFAULT_PROVIDER, ROUTE_PROVIDER_FIRST, ROUTE_OPTIONS, FIELD_SPECS } from "./config.js";
import { buildFieldShell, buildHint } from "./dom.js";

export function buildProviderSelect({ settings, translate, onProviderChange }) {
	const field = buildFieldShell(translate("providerLabel"));
	field.setAttribute(PROVIDER_MARKER, "");
	const select = document.createElement("select");
	select.className = "At1oFq_input";
	for (const provider of PROVIDERS) {
		const option = document.createElement("option");
		option.value = provider.value;
		option.textContent = translate(provider.labelKey);
		select.appendChild(option);
	}
	select.value = settings.readProvider(DEFAULT_PROVIDER);
	select.addEventListener("change", () => {
		try {
			onProviderChange(select.value);
		} catch (error) {
			console.warn("[@mr.robot/dsh-web-search-extend] failed to persist provider", error);
		}
	});
	field.appendChild(select);
	buildHint(field, translate("providerHint"));
	return field;
}

export function buildRouteModeSelect({ settings, translate }) {
	const field = buildFieldShell(translate("routeModeLabel"));
	field.setAttribute("data-wse-route", "");
	const select = document.createElement("select");
	select.className = "At1oFq_input";
	for (const optionSpec of ROUTE_OPTIONS) {
		const option = document.createElement("option");
		option.value = optionSpec.value;
		option.textContent = translate(optionSpec.labelKey);
		select.appendChild(option);
	}
	select.value = settings.readRouteMode(ROUTE_PROVIDER_FIRST);
	select.addEventListener("change", () => settings.setRouteMode(select.value));
	field.appendChild(select);
	return field;
}

function attachValueControl(field, spec, section, { settings }) {
	const current = () => {
		const value = settings.readSection(section)[spec.key];
		return value === undefined || value === null ? spec.default : value;
	};

	if (spec.type === "select") {
		const select = document.createElement("select");
		select.className = "At1oFq_input";
		for (const option of spec.options) {
			const optionEl = document.createElement("option");
			optionEl.value = option;
			optionEl.textContent = option;
			select.appendChild(optionEl);
		}
		select.value = String(current());
		select.addEventListener("change", () => settings.writeParam(section, spec.key, select.value));
		field.appendChild(select);
		return select;
	}

	if (spec.type === "bool") {
		const wrap = document.createElement("div");
		wrap.style.cssText = "display:flex;align-items:center;gap:8px;";
		const box = document.createElement("input");
		box.type = "checkbox";
		box.checked = Boolean(current());
		box.addEventListener("change", () => settings.writeParam(section, spec.key, box.checked));
		wrap.appendChild(box);
		field.appendChild(wrap);
		return box;
	}

	const input = document.createElement("input");
	input.className = "At1oFq_input";
	input.type = "text";
	if (spec.type === "number") input.inputMode = "numeric";
	input.value = String(current());
	input.addEventListener("change", () => {
		if (spec.type === "number") {
			const raw = input.value.trim();
			const n = raw === "" ? spec.default : Number(raw);
			if (!Number.isFinite(n) || n < 1) {
				input.value = String(current());
				return;
			}
			settings.writeParam(section, spec.key, n);
			input.value = String(n);
			return;
		}
		settings.writeParam(section, spec.key, input.value.trim());
	});
	field.appendChild(input);
	return input;
}

export function buildParamFields(container, { settings, translate }) {
	for (const provider of PROVIDERS) {
		const section = provider.value;
		const specs = FIELD_SPECS[section] ?? [];
		if (specs.length === 0) continue;
		for (const spec of specs) {
			const field = buildFieldShell(translate(`${section}.${spec.key}.label`));
			field.setAttribute("data-wse-param", `${section}.${spec.key}`);
			field.setAttribute("data-wse-for", section);
			attachValueControl(field, spec, section, { settings });
			buildHint(field, translate(`${section}.${spec.key}.hint`));
			container.appendChild(field);
		}
	}
}
