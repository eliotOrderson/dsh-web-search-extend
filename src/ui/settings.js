export function createSettingsAccess(settingsScope) {
	const scope = settingsScope.bind({ namespace: "web-search-deepseek" });

	const snapshot = () => {
		try {
			return scope.getSnapshot() ?? {};
		} catch {
			return {};
		}
	};

	const readSection = (section) => {
		const snap = snapshot();
		return snap.value?.[section] ?? snap.base?.[section] ?? {};
	};

	const readProvider = (fallback) => {
		const snap = snapshot();
		return snap.value?.provider ?? snap.base?.provider ?? fallback;
	};

	const readRouteMode = (fallback) => {
		const snap = snapshot();
		return snap.value?.routeMode ?? snap.base?.routeMode ?? fallback;
	};

	const writeParam = (section, key, value) => {
		try {
			scope.write({ op: "set", path: [section, key], value });
		} catch (error) {
			console.warn("[@mr.robot/dsh-web-search-extend] failed to persist", section + "." + key, error);
		}
	};

	const setProvider = (provider) => {
		try {
			scope.set("provider", provider);
			return true;
		} catch (error) {
			console.warn("[@mr.robot/dsh-web-search-extend] failed to persist provider", error);
			return false;
		}
	};

	const setRouteMode = (routeMode) => {
		try {
			scope.set("routeMode", routeMode);
		} catch (error) {
			console.warn("[@mr.robot/dsh-web-search-extend] failed to persist routeMode", error);
		}
	};

	const subscribe = (listener) => scope.subscribe(listener);

	return { readSection, readProvider, readRouteMode, writeParam, setProvider, setRouteMode, subscribe };
}
