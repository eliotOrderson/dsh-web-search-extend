export function findBody() {
	const key = document.getElementById("plugin-config-web-search-key");
	if (!key) return null;
	const card = key.closest("li");
	if (!card) return null;
	return [...card.children].find(
		(c) => c.tagName === "DIV" && c.querySelector("#plugin-config-web-search-key"),
	) ?? null;
}

export function hideCoreField(id) {
	const el = document.getElementById(id);
	if (!el) return;
	const field = el.closest(".At1oFq_field");
	if (field) field.style.display = "none";
}

export function buildFieldShell(labelText) {
	const field = document.createElement("div");
	field.className = "At1oFq_field";
	const head = document.createElement("div");
	head.className = "At1oFq_head";
	const labelEl = document.createElement("label");
	labelEl.className = "At1oFq_label";
	labelEl.textContent = labelText;
	head.appendChild(labelEl);
	field.appendChild(head);
	return field;
}

export function buildHint(field, text) {
	if (!text) return;
	const hint = document.createElement("p");
	hint.className = "At1oFq_hint";
	hint.textContent = text;
	field.appendChild(hint);
}
